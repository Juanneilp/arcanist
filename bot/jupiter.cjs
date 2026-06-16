const { VersionedTransaction } = require('@solana/web3.js');
const fs = require('fs');
const path = require('path');
const { fetchWithRetry, rpcRetryWrapper } = require('./api-utils.cjs');

async function getJupiterOrder(inputMint, outputMint, amountLamports, takerPublicKey, slippageBps = 50) {
    const params = new URLSearchParams({
        inputMint,
        outputMint,
        amount: amountLamports.toString(),
        taker: takerPublicKey.toString(),
        slippageBps: slippageBps.toString()
    });
    
    const url = `https://api.jup.ag/swap/v2/order?${params.toString()}`;
    const response = await fetchWithRetry(url);
    
    if (!response.ok) {
        let errorMsg = response.statusText;
        try {
            const errorData = await response.json();
            errorMsg = errorData.error || errorMsg;
        } catch (e) {}
        throw new Error(`Jupiter Order API Error: ${errorMsg}`);
    }
    
    const order = await response.json();
    if (order.error) {
        throw new Error(`Jupiter Order Error: ${order.error}`);
    }
    
    return order;
}

// Deprecated V1 mock for compatibility if required elsewhere
async function getQuote(inputMint, outputMint, amountLamports, slippageBps = 50) {
    const params = new URLSearchParams({
        inputMint,
        outputMint,
        amount: amountLamports.toString(),
        slippageBps: slippageBps.toString()
    });
    const url = `https://api.jup.ag/swap/v2/order?${params.toString()}`;
    const response = await fetchWithRetry(url);
    if (!response.ok) throw new Error(`Jupiter Quote API Error: ${response.statusText}`);
    return await response.json();
}

async function executeSwap(connection, walletKeypair, order, mode = "dry_run") {
    if (mode !== "live") {
        console.log(`[DRY RUN] Simulating swap execution...`);
        return { signature: "simulate_swap_txid_" + Date.now() };
    }
    
    if (!order.transaction) {
        throw new Error("Order has no transaction to sign (is taker set correctly, and do you have funds?).");
    }

    const swapTransactionBuf = Buffer.from(order.transaction, 'base64');
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    
    transaction.sign([walletKeypair]);
    const signedTx = Buffer.from(transaction.serialize()).toString('base64');

    const executeUrl = 'https://api.jup.ag/swap/v2/execute';
    const response = await fetchWithRetry(executeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            signedTransaction: signedTx,
            requestId: order.requestId,
        })
    });
    
    if (!response.ok) {
        let errorMsg = response.statusText;
        try {
            const errorData = await response.json();
            errorMsg = errorData.error || errorMsg;
        } catch (e) {}
        throw new Error(`Jupiter Execute API Error: ${errorMsg}`);
    }
    
    const result = await response.json();
    if (result.status === 'Success' || result.signature) {
        return {
            signature: result.signature,
            inputAmount: result.inputAmountResult,
            outputAmount: result.outputAmountResult
        };
    }
    
    throw new Error(`Swap failed: ${result.error || 'unknown'}, Code: ${result.code}`);
}

async function swapSolToToken(connection, walletKeypair, tokenMint, solAmount, mode = "dry_run") {
    const WSOL_MINT = 'So11111111111111111111111111111111111111112';
    const amountLamports = Math.floor(solAmount * 1e9);
    
    console.log(`Getting order for swapping ${solAmount} SOL to ${tokenMint}...`);
    const order = await getJupiterOrder(WSOL_MINT, tokenMint, amountLamports, walletKeypair.publicKey);
    
    console.log(`Expected Output: ${order.outAmount} (smallest units)`);
    
    console.log(`Executing swap transaction via Jupiter (${mode.toUpperCase()})...`);
    const result = await executeSwap(connection, walletKeypair, order, mode);
    const txid = result.signature || result; 
    console.log(`Swap successful! Transaction ID: ${txid}`);
    
    return {
        txid,
        expectedOutAmount: order.outAmount
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
    
    console.log(`Getting order for swapping ${tokenAmountRaw} (raw units) of ${tokenMint} to SOL...`);
    const order = await getJupiterOrder(tokenMint, WSOL_MINT, tokenAmountRaw, walletKeypair.publicKey);
    
    const expectedSolOut = order.outAmount / 1e9;
    const solPrice = await getSolPriceUsd();
    const usdValue = expectedSolOut * solPrice;
    
    console.log(`Expected Output: ${expectedSolOut} SOL (~$${usdValue.toFixed(2)})`);
    
    const configPath = path.join(__dirname, '..', 'user-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const threshold = config.exitConfig?.minUsdDustValueToSwap || 0.5;
    
    if (usdValue >= threshold) {
        console.log(`Value >= $${threshold}. Executing dust sweep swap (${mode.toUpperCase()})...`);
        const result = await executeSwap(connection, walletKeypair, order, mode);
        const txid = result.signature || result;
        console.log(`Dust Sweep successful! Transaction ID: ${txid}`);
        return { txid, expectedSolOut, usdValue };
    } else {
        console.log(`Dust value < $${threshold}. Skipping swap.`);
        return { skipped: true, usdValue };
    }
}

module.exports = {
    getJupiterOrder,
    getQuote,
    executeSwap,
    swapSolToToken,
    swapTokenToSol,
    getSolPriceUsd
};
