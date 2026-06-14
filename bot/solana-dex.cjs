const { PublicKey, Connection, Keypair, VersionedTransaction } = require('@solana/web3.js');
const DLMM = require('@meteora-ag/dlmm');
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

async function executeSwap(connection, walletKeypair, swapTransactionBase64, mode = "dry_run") {
    if (mode !== "live") {
        console.log(`[DRY RUN] Simulating swap execution...`);
        return "simulate_swap_txid_" + Date.now();
    }
    
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

async function swapSolToToken(connection, walletKeypair, tokenMint, solAmount, mode = "dry_run") {
    const WSOL_MINT = 'So11111111111111111111111111111111111111112';
    const amountLamports = Math.floor(solAmount * 1e9);
    
    console.log(`Getting quote for swapping ${solAmount} SOL to ${tokenMint}...`);
    const quoteResponse = await getQuote(WSOL_MINT, tokenMint, amountLamports);
    
    console.log(`Expected Output: ${quoteResponse.outAmount} (smallest units)`);
    console.log(`Building swap transaction...`);
    const swapTx = await getSwapTransaction(quoteResponse, walletKeypair.publicKey);
    
    console.log(`Executing swap transaction (${mode.toUpperCase()})...`);
    const txid = await executeSwap(connection, walletKeypair, swapTx, mode);
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

async function swapTokenToSol(connection, walletKeypair, tokenMint, tokenAmountUi, mode = "dry_run") {
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
        console.log(`Executing dust sweep swap (${mode.toUpperCase()})...`);
        const txid = await executeSwap(connection, walletKeypair, swapTx, mode);
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
        // 1. Reliable Data Source: Use DexScreener to find all Meteora pairs for this token
        const dsRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mintA}`);
        const dsData = await dsRes.json();
        
        let poolAddresses = [];
        if (dsData && dsData.pairs) {
            const meteoraPairs = dsData.pairs.filter(p => 
                p.dexId === 'meteora' && 
                ((p.baseToken.address === mintA && p.quoteToken.address === mintB) || 
                 (p.baseToken.address === mintB && p.quoteToken.address === mintA))
            );
            poolAddresses = meteoraPairs.map(p => p.pairAddress);
        }
        
        const matchingPools = [];
        // 2. Fetch specific pool details from Meteora Datapi
        for (const address of poolAddresses) {
            try {
                const pRes = await fetch(`https://dlmm.datapi.meteora.ag/pools/${address}`);
                if (pRes.ok) {
                    const poolData = await pRes.json();
                    if (poolData && poolData.address) {
                        // Ensure compatibility with existing properties (liquidity is tvl, token_x etc)
                        poolData.liquidity = poolData.tvl;
                        poolData.mint_x = poolData.token_x?.address;
                        poolData.mint_y = poolData.token_y?.address;
                        if (poolData.pool_config) {
                            poolData.bin_step = poolData.pool_config.bin_step;
                        }
                        matchingPools.push(poolData);
                    }
                }
            } catch (e) {
                console.error(`Failed to fetch specific pool ${address}`, e);
            }
        }
        
        return matchingPools;
    } catch (e) {
        console.error("Failed to fetch pools from Data Sources.", e);
        return [];
    }
}

async function addLiquidity(connection, walletKeypair, poolAddressStr, solMint, solLamports, minRange, maxRange, strategyOptions, mode = "dry_run") {
    const poolAddress = new PublicKey(poolAddressStr);
    console.log(`Initializing DLMM Pool instance for ${poolAddressStr}...`);
    const dlmmPool = await DLMM.create(connection, poolAddress);
    
    const activeBin = await dlmmPool.getActiveBin();
    console.log(`Current Active Bin Price: ${activeBin.price}`);
    
    const isSolX = dlmmPool.tokenX.publicKey.toBase58() === solMint;
    let minBin, maxBin, newBalanceX, newBalanceY;
    
    if (isSolX) {
        // SOL is Token X -> Buy Y (Meme)
        // Cheap Meme = higher Y per X = higher binId. Expensive Meme = lower binId.
        // User maxRange (+1%) means expensive Meme -> lower binId. 
        // User minRange (-90%) means cheap Meme -> higher binId.
        const rawMin = activeBin.binId - maxRange;
        const rawMax = activeBin.binId - minRange;
        
        // We provide Token X, so we can only provide in bins >= activeBin
        minBin = Math.max(rawMin, activeBin.binId);
        maxBin = Math.max(rawMax, activeBin.binId);
        
        newBalanceX = new BN(solLamports);
        newBalanceY = new BN(0);
    } else {
        // SOL is Token Y -> Buy X (Meme)
        // Cheap Meme = lower Y per X = lower binId. Expensive Meme = higher binId.
        const rawMin = activeBin.binId + minRange;
        const rawMax = activeBin.binId + maxRange;
        
        // We provide Token Y, so we can only provide in bins <= activeBin
        minBin = Math.min(rawMin, activeBin.binId);
        maxBin = Math.min(rawMax, activeBin.binId);
        
        newBalanceX = new BN(0);
        newBalanceY = new BN(solLamports);
    }
    
    const newPositionKeypair = Keypair.generate();
    
    console.log(`Creating InitializePositionAndAddLiquidityByStrategy transaction...`);
    try {
        if (mode === "live") {
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
            
            console.log(`[LIVE] Sending Add Liquidity transaction...`);
            const txid = await connection.sendTransaction(createPositionTx, [walletKeypair, newPositionKeypair]);
            console.log(`[LIVE] Transaction Sent. TXID: ${txid}`);
        } else {
            console.log(`[DRY RUN] Transaction building skipped to avoid simulation errors on dummy wallet.`);
        }
        
        return { 
            status: mode === "live" ? "success" : "simulate_success", 
            positionPubKey: newPositionKeypair.publicKey.toBase58() 
        };
    } catch (e) {
        console.error("Error adding liquidity:", e);
        throw e;
    }
}

async function removeLiquidity(connection, walletKeypair, poolAddressStr, positionPubKeyStr, mode = "dry_run") {
    const poolAddress = new PublicKey(poolAddressStr);
    const positionPubKey = new PublicKey(positionPubKeyStr);
    
    console.log(`Initializing DLMM Pool instance for ${poolAddressStr}...`);
    const dlmmPool = await DLMM.create(connection, poolAddress);
    
    console.log(`Creating removeLiquidity transaction for position ${positionPubKeyStr}...`);
    try {
        if (mode === "live") {
            const removeTx = await dlmmPool.removeLiquidity({
                position: positionPubKey,
                user: walletKeypair.publicKey,
                bps: new BN(10000),
                shouldClaimAndClose: true
            });
            
            console.log(`[LIVE] Sending Remove Liquidity transaction...`);
            const txid = await connection.sendTransaction(removeTx, [walletKeypair]);
            console.log(`[LIVE] Transaction Sent. TXID: ${txid}`);
        } else {
            console.log(`[DRY RUN] Transaction building skipped to avoid simulation errors on dummy wallet.`);
        }
        return { status: mode === "live" ? "success" : "simulate_success" };
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
