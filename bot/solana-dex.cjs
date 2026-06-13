const { PublicKey, Connection, Keypair, VersionedTransaction } = require('@solana/web3.js');
const { DLMM } = require('@meteora-ag/dlmm');
const BN = require('bn.js');
const fs = require('fs');
const path = require('path');

// --- JUPITER LOGIC ---
async function getQuote(inputMint, outputMint, amountLamports, slippageBps = 50) {
    const url = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=${slippageBps}`;
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Jupiter Quote API Error: ${response.statusText}`);
    }
    const quoteResponse = await response.json();
    return quoteResponse;
}

async function getSwapTransaction(quoteResponse, walletPublicKey) {
    const url = 'https://quote-api.jup.ag/v6/swap';
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            quoteResponse,
            userPublicKey: walletPublicKey.toString(),
            wrapAndUnwrapSol: true,
        })
    });
    if (!response.ok) {
        throw new Error(`Jupiter Swap API Error: ${response.statusText}`);
    }
    const { swapTransaction } = await response.json();
    return swapTransaction;
}

async function executeSwap(connection, walletKeypair, swapTransactionBase64) {
    const swapTransactionBuf = Buffer.from(swapTransactionBase64, 'base64');
    var transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    
    transaction.sign([walletKeypair]);

    const latestBlockHash = await connection.getLatestBlockhash();
    const rawTransaction = transaction.serialize();
    
    const txid = await connection.sendRawTransaction(rawTransaction, {
        skipPreflight: true,
        maxRetries: 2
    });
    
    await connection.confirmTransaction({
        blockhash: latestBlockHash.blockhash,
        lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
        signature: txid
    });
    
    return txid;
}

async function swapSolToToken(connection, walletKeypair, tokenMint, solAmount) {
    const WSOL_MINT = 'So11111111111111111111111111111111111111112';
    const amountLamports = Math.floor(solAmount * 1e9);
    
    console.log(`Getting quote for swapping ${solAmount} SOL to ${tokenMint}...`);
    const quoteResponse = await getQuote(WSOL_MINT, tokenMint, amountLamports);
    
    console.log(`Expected Output: ${quoteResponse.outAmount} (smallest units)`);
    console.log(`Building swap transaction...`);
    const swapTx = await getSwapTransaction(quoteResponse, walletKeypair.publicKey);
    
    console.log(`Executing swap transaction...`);
    const txid = await executeSwap(connection, walletKeypair, swapTx);
    console.log(`Swap successful! Transaction ID: ${txid}`);
    
    return {
        txid,
        expectedOutAmount: quoteResponse.outAmount
    };
}

async function getSolPriceUsd() {
    try {
        const response = await fetch("https://price.jup.ag/v6/price?ids=SOL");
        if (response.ok) {
            const data = await response.json();
            return data.data.SOL.price;
        }
    } catch (e) {
        console.error("Failed to fetch SOL price", e.message);
    }
    return 150; 
}

async function swapTokenToSol(connection, walletKeypair, tokenMint, tokenAmountUi) {
    const WSOL_MINT = 'So11111111111111111111111111111111111111112';
    
    console.log(`Getting quote for swapping ${tokenAmountUi} of ${tokenMint} to SOL...`);
    const quoteResponse = await getQuote(tokenMint, WSOL_MINT, tokenAmountUi);
    
    const expectedSolOut = quoteResponse.outAmount / 1e9;
    const solPrice = await getSolPriceUsd();
    const usdValue = expectedSolOut * solPrice;
    
    console.log(`Expected Output: ${expectedSolOut} SOL (~$${usdValue.toFixed(2)})`);
    
    const configPath = path.join(__dirname, '..', 'user-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const threshold = config.exitConfig?.minUsdDustValueToSwap || 0.5;
    
    if (usdValue >= threshold) {
        console.log(`Value >= $${threshold}. Building swap transaction...`);
        const swapTx = await getSwapTransaction(quoteResponse, walletKeypair.publicKey);
        console.log(`Executing dust sweep swap...`);
        const txid = await executeSwap(connection, walletKeypair, swapTx);
        console.log(`Dust Sweep successful! Transaction ID: ${txid}`);
        return { txid, expectedSolOut, usdValue };
    } else {
        console.log(`Dust value < $${threshold}. Skipping swap.`);
        return { skipped: true, usdValue };
    }
}

// --- METEORA LOGIC ---
async function fetchMeteoraPools(mintA, mintB) {
    console.log(`Searching for Meteora DLMM pools for ${mintA} and ${mintB}...`);
    try {
        const response = await fetch(`https://dlmm.datapi.meteora.ag/pools`);
        const pools = await response.json();
        
        const matchingPools = pools.filter(p => 
            (p.mint_x === mintA && p.mint_y === mintB) || 
            (p.mint_x === mintB && p.mint_y === mintA)
        );
        return matchingPools;
    } catch (e) {
        console.error("Failed to fetch pools from Meteora Datapi.", e);
        return [];
    }
}

async function addLiquidity(connection, walletKeypair, poolAddressStr, solMint, solLamports, binRange, strategyOptions) {
    const poolAddress = new PublicKey(poolAddressStr);
    console.log(`Initializing DLMM Pool instance for ${poolAddressStr}...`);
    const dlmmPool = await DLMM.create(connection, poolAddress);
    
    const activeBin = await dlmmPool.getActiveBin();
    console.log(`Current Active Bin Price: ${activeBin.price}`);
    
    const isSolX = dlmmPool.tokenX.publicKey.toBase58() === solMint;
    let minBin, maxBin, newBalanceX, newBalanceY;
    
    if (isSolX) {
        minBin = activeBin.binId;
        maxBin = activeBin.binId + binRange;
        newBalanceX = new BN(solLamports);
        newBalanceY = new BN(0);
    } else {
        minBin = activeBin.binId - binRange;
        maxBin = activeBin.binId;
        newBalanceX = new BN(0);
        newBalanceY = new BN(solLamports);
    }
    
    const newPositionKeypair = Keypair.generate();
    
    console.log(`Creating InitializePositionAndAddLiquidityByStrategy transaction...`);
    try {
        const createPositionTx = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
            positionPubKey: newPositionKeypair.publicKey, 
            user: walletKeypair.publicKey,
            totalXAmount: newBalanceX,
            totalYAmount: newBalanceY,
            strategy: {
                maxBinId: maxBin,
                minBinId: minBin,
                strategyType: strategyOptions.type || 0 
            }
        });
        
        console.log(`Transaction built. Note: Execution is commented out for safety.`);
        // const txid = await connection.sendTransaction(createPositionTx, [walletKeypair, newPositionKeypair]);
        
        return { 
            status: "simulate_success", 
            positionPubKey: newPositionKeypair.publicKey.toBase58() 
        };
    } catch (e) {
        console.error("Error adding liquidity:", e);
        throw e;
    }
}

async function removeLiquidity(connection, walletKeypair, poolAddressStr, positionPubKeyStr) {
    const poolAddress = new PublicKey(poolAddressStr);
    const positionPubKey = new PublicKey(positionPubKeyStr);
    
    console.log(`Initializing DLMM Pool instance for ${poolAddressStr}...`);
    const dlmmPool = await DLMM.create(connection, poolAddress);
    
    console.log(`Creating removeLiquidity transaction for position ${positionPubKeyStr}...`);
    try {
        const removeTx = await dlmmPool.removeLiquidity({
            position: positionPubKey,
            user: walletKeypair.publicKey,
            bps: new BN(10000),
            shouldClaimAndClose: true
        });
        
        console.log(`Remove transaction built. Note: Execution is commented out for safety.`);
        // const txid = await connection.sendTransaction(removeTx, [walletKeypair]);
        return { status: "simulate_success" };
    } catch (e) {
        console.error("Error removing liquidity:", e);
        throw e;
    }
}

module.exports = {
    swapSolToToken,
    swapTokenToSol,
    getSolPriceUsd,
    fetchMeteoraPools,
    addLiquidity,
    removeLiquidity
};
