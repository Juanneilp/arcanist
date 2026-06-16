const { VersionedTransaction } = require('@solana/web3.js');
const fs = require('fs');
const path = require('path');
const { fetchWithRetry, rpcRetryWrapper } = require('./api-utils.cjs');

async function getQuote(inputMint, outputMint, amountLamports, slippageBps = 50) {
    const url = `https://api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=${slippageBps}`;
    const response = await fetchWithRetry(url);
    if (!response.ok) {
        throw new Error(`Jupiter Quote API Error: ${response.statusText}`);
    }
    const quoteResponse = await response.json();
    return quoteResponse;
}

async function getSwapTransaction(quoteResponse, walletPublicKey) {
    const url = 'https://api.jup.ag/swap/v1/swap';
    const response = await fetchWithRetry(url, {
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
    
    const txid = await rpcRetryWrapper(async () => {
        return await connection.sendRawTransaction(rawTransaction, {
            skipPreflight: true,
            maxRetries: 2
        });
    });
    
    await rpcRetryWrapper(async () => {
        await connection.confirmTransaction({
            blockhash: latestBlockHash.blockhash,
            lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
            signature: txid
        });
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
        const WSOL_MINT = 'So11111111111111111111111111111111111111112';
        const response = await fetchWithRetry(`https://api.jup.ag/price/v3?ids=${WSOL_MINT}`);
        if (response.ok) {
            const data = await response.json();
            if (data[WSOL_MINT] && data[WSOL_MINT].usdPrice) {
                return parseFloat(data[WSOL_MINT].usdPrice);
            } else if (data.data && data.data[WSOL_MINT]) {
                return parseFloat(data.data[WSOL_MINT].price || data.data[WSOL_MINT].usdPrice);
            }
        }
    } catch (e) {
        console.error("Failed to fetch SOL price", e.message);
    }
    return 150; 
}

async function swapTokenToSol(connection, walletKeypair, tokenMint, tokenAmountRaw, mode = "dry_run") {
    const WSOL_MINT = 'So11111111111111111111111111111111111111112';
    
    console.log(`Getting quote for swapping ${tokenAmountRaw} (raw units) of ${tokenMint} to SOL...`);
    const quoteResponse = await getQuote(tokenMint, WSOL_MINT, tokenAmountRaw);
    
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

module.exports = {
    getQuote,
    getSwapTransaction,
    executeSwap,
    swapSolToToken,
    swapTokenToSol,
    getSolPriceUsd
};
