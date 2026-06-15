const { PublicKey, Connection, Keypair, VersionedTransaction, TransactionMessage, Transaction } = require('@solana/web3.js');
const DLMM = require('@meteora-ag/dlmm');
const { Zap } = require('@meteora-ag/zap-sdk');
const BN = require('bn.js');
const fs = require('fs');
const path = require('path');
const { fetchWithRetry, rpcRetryWrapper } = require('./api-utils.cjs');

// --- JUPITER LOGIC ---
async function getQuote(inputMint, outputMint, amountLamports, slippageBps = 50) {
    const url = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=${slippageBps}`;
    const response = await fetchWithRetry(url);
    if (!response.ok) {
        throw new Error(`Jupiter Quote API Error: ${response.statusText}`);
    }
    const quoteResponse = await response.json();
    return quoteResponse;
}

async function getSwapTransaction(quoteResponse, walletPublicKey) {
    const url = 'https://quote-api.jup.ag/v6/swap';
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
async function fetchMeteoraPools(query, allowedQuoteTokens = []) {
    console.log(`Searching for Meteora DLMM pools for ${query}...`);
    try {
        const url = `https://dlmm.datapi.meteora.ag/pools?query=${encodeURIComponent(query)}`;
        const res = await fetchWithRetry(url);
        if (!res.ok) {
            console.error(`Meteora API Error: ${res.statusText}`);
            return [];
        }
        
        const data = await res.json();
        const pools = (Array.isArray(data) ? data : data.data || []);
        
        let matchingPools = pools.map(p => ({
            address: p.address || p.pool_address,
            poolAddress: p.address || p.pool_address,
            name: p.name,
            bin_step: p.bin_step ?? p.dlmm_params?.bin_step ?? p.pool_config?.bin_step,
            liquidity: p.liquidity ?? p.tvl,
            mint_x: p.mint_x ?? p.token_x?.address,
            mint_y: p.mint_y ?? p.token_y?.address,
            symbol_x: p.mint_x_symbol ?? p.token_x?.symbol,
            symbol_y: p.mint_y_symbol ?? p.token_y?.symbol,
        }));
        
        if (allowedQuoteTokens && Array.isArray(allowedQuoteTokens) && allowedQuoteTokens.length > 0) {
            matchingPools = matchingPools.filter(p => 
                allowedQuoteTokens.includes(p.symbol_x) || allowedQuoteTokens.includes(p.symbol_y)
            );
        }
        
        return matchingPools;
    } catch (e) {
        console.error("Failed to fetch pools from Meteora Datapi.", e);
        return [];
    }
}

async function addLiquidity(connection, walletKeypair, poolAddressStr, solMint, solLamports, minRange, maxRange, strategyOptions, mode = "dry_run") {
    const poolAddress = new PublicKey(poolAddressStr);
    console.log(`Initializing DLMM Pool instance for ${poolAddressStr}...`);
    const dlmmPool = await DLMM.create(connection, poolAddress, { cluster: "mainnet-beta" });
    
    const activeBin = await dlmmPool.getActiveBin();
    console.log(`Current Active Bin Price: ${activeBin.price}`);
    
    const isSolX = dlmmPool.tokenX.publicKey.toBase58() === solMint;
    let minBin, maxBin, newBalanceX, newBalanceY;
    
    // Parse prices using the raw price for accurate bin calculation
    // Meteora snippet incorrectly used UI price (fromPricePerLamport) directly in getBinIdFromPrice
    // which expects raw price (or requires toPricePerLamport conversion first).
    const currentRawPrice = Number(activeBin.price);
    
    // Calculate price boundaries based on percentage (-90 = -90%, 1 = +1%)
    const minPrice = currentRawPrice * (1 + (minRange / 100));
    const maxPrice = currentRawPrice * (1 + (maxRange / 100));
    
    // Find absolute bin bounds
    const rawMinBin = dlmmPool.getBinIdFromPrice(minPrice, true);
    const rawMaxBin = dlmmPool.getBinIdFromPrice(maxPrice, false);
    
    if (isSolX) {
        // SOL is Token X -> Buy Y (Meme)
        const sortedMin = Math.min(rawMinBin, rawMaxBin);
        const sortedMax = Math.max(rawMinBin, rawMaxBin);
        // We provide Token X, so we can only provide in bins >= activeBin
        minBin = Math.max(sortedMin, activeBin.binId);
        maxBin = Math.max(sortedMax, activeBin.binId);
        
        newBalanceX = new BN(solLamports);
        newBalanceY = new BN(0);
    } else {
        // SOL is Token Y -> Buy X (Meme)
        const sortedMin = Math.min(rawMinBin, rawMaxBin);
        const sortedMax = Math.max(rawMinBin, rawMaxBin);
        // We provide Token Y, so we can only provide in bins <= activeBin
        minBin = Math.min(sortedMin, activeBin.binId);
        maxBin = Math.min(sortedMax, activeBin.binId);
        
        newBalanceX = new BN(0);
        newBalanceY = new BN(solLamports);
    }
    
    const newPositionKeypair = Keypair.generate();
    
    const isWideRange = (maxBin - minBin > 69);
    console.log(`Creating liquidity transaction(s)... Wide Range: ${isWideRange}`);
    
    try {
        console.log(`[QUOTE] Checking for non-refundable costs...`);
        const quote = await dlmmPool.quoteCreatePosition({
            strategy: {
                maxBinId: maxBin,
                minBinId: minBin,
                strategyType: strategyOptions.type || 0 
            }
        });
        
        const binArrayCost = quote.binArrayCost || 0;
        const positionCost = quote.positionCost || 0;
        const positionReallocCost = quote.positionReallocCost || 0;
        
        console.log(`[QUOTE] Position cost (refundable): ${positionCost} SOL`);
        console.log(`[QUOTE] Position realloc cost (refundable): ${positionReallocCost} SOL`);
        console.log(`[QUOTE] Bin array cost (NON-refundable): ${binArrayCost} SOL`);
        console.log(`[QUOTE] Bin array count: ${quote.binArraysCount}`);
        
        if (binArrayCost > 0) {
            console.log(`[SKIP] Skipping deploy: Non-refundable binArray cost detected! Cost: ${binArrayCost} SOL`);
            return { 
                status: "skipped", 
                reason: "non_refundable_cost",
                cost: binArrayCost
            };
        }
        console.log(`[QUOTE] Safe to deploy! No non-refundable cost.`);
        
        if (mode === "live") {
            if (isWideRange) {
                console.log(`[LIVE] Sending Create Extended Empty Position transaction(s)...`);
                const createTxs = await dlmmPool.createExtendedEmptyPosition(
                    minBin,
                    maxBin,
                    newPositionKeypair.publicKey,
                    walletKeypair.publicKey
                );
                
                const createTxArray = Array.isArray(createTxs) ? createTxs : [createTxs];
                for (let i = 0; i < createTxArray.length; i++) {
                    const txid = await rpcRetryWrapper(async () => {
                        const latestBlockHash = await connection.getLatestBlockhash();
                        createTxArray[i].recentBlockhash = latestBlockHash.blockhash;
                        const signers = i === 0 ? [walletKeypair, newPositionKeypair] : [walletKeypair];
                        const sig = await connection.sendTransaction(createTxArray[i], signers);
                        await connection.confirmTransaction({
                            signature: sig,
                            blockhash: latestBlockHash.blockhash,
                            lastValidBlockHeight: latestBlockHash.lastValidBlockHeight
                        }, "confirmed");
                        return sig;
                    });
                    console.log(`[LIVE] Create TX ${i+1}/${createTxArray.length} Confirmed. TXID: ${txid}`);
                }
                
                console.log(`[LIVE] Sending Add Liquidity (Chunkable) transaction(s)...`);
                const addTxs = await dlmmPool.addLiquidityByStrategyChunkable({
                    positionPubKey: newPositionKeypair.publicKey,
                    user: walletKeypair.publicKey,
                    totalXAmount: newBalanceX,
                    totalYAmount: newBalanceY,
                    strategy: {
                        maxBinId: maxBin,
                        minBinId: minBin,
                        strategyType: strategyOptions.type || 0 
                    },
                    slippage: 10 // 10%
                });
                
                const addTxArray = Array.isArray(addTxs) ? addTxs : [addTxs];
                for (let i = 0; i < addTxArray.length; i++) {
                    const txid = await rpcRetryWrapper(async () => {
                        const latestBlockHash = await connection.getLatestBlockhash();
                        addTxArray[i].recentBlockhash = latestBlockHash.blockhash;
                        const sig = await connection.sendTransaction(addTxArray[i], [walletKeypair]);
                        await connection.confirmTransaction({
                            signature: sig,
                            blockhash: latestBlockHash.blockhash,
                            lastValidBlockHeight: latestBlockHash.lastValidBlockHeight
                        }, "confirmed");
                        return sig;
                    });
                    console.log(`[LIVE] Add Liquidity TX ${i+1}/${addTxArray.length} Confirmed. TXID: ${txid}`);
                }
            } else {
                const createPositionTx = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
                    positionPubKey: newPositionKeypair.publicKey, 
                    user: walletKeypair.publicKey,
                    totalXAmount: newBalanceX,
                    totalYAmount: newBalanceY,
                    strategy: {
                        maxBinId: maxBin,
                        minBinId: minBin,
                        strategyType: strategyOptions.type || 0 
                    },
                    slippage: 1000 // 10% in bps
                });
                
                console.log(`[LIVE] Sending Add Liquidity transaction...`);
                const txid = await rpcRetryWrapper(async () => {
                    const latestBlockHash = await connection.getLatestBlockhash();
                    createPositionTx.recentBlockhash = latestBlockHash.blockhash;
                    const sig = await connection.sendTransaction(createPositionTx, [walletKeypair, newPositionKeypair]);
                    await connection.confirmTransaction({
                        signature: sig,
                        blockhash: latestBlockHash.blockhash,
                        lastValidBlockHeight: latestBlockHash.lastValidBlockHeight
                    }, "confirmed");
                    return sig;
                });
                console.log(`[LIVE] Transaction Confirmed. TXID: ${txid}`);
            }
        } else {
            console.log(`[DRY RUN] Transaction building skipped to avoid simulation errors on dummy wallet.`);
        }
        
        return { 
            status: mode === "live" ? "success" : "simulate_success", 
            positionPubKey: newPositionKeypair.publicKey.toBase58(),
            activeBinPrice: activeBin.price,
            minBinId: minBin,
            maxBinId: maxBin
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
    const dlmmPool = await DLMM.create(connection, poolAddress, { cluster: "mainnet-beta" });
    
    try {
        if (mode === "live") {
            const txids = [];
            
            let hasLiquidity = false;
            let closeFromBinId = 0;
            let closeToBinId = 0;
            let tokenBalanceLamports = new BN(0);
            
            try {
                const positionData = await dlmmPool.getPosition(positionPubKey);
                if (positionData && positionData.positionData) {
                    const pd = positionData.positionData;
                    closeFromBinId = pd.lowerBinId ?? closeFromBinId;
                    closeToBinId = pd.upperBinId ?? closeToBinId;
                    const bins = Array.isArray(pd.positionBinData) ? pd.positionBinData : [];
                    hasLiquidity = bins.some(bin => new BN(bin.positionLiquidity || "0").gt(new BN(0)));
                }
                
                const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(walletKeypair.publicKey);
                const posData = userPositions.find(p => p.publicKey.toBase58() === positionPubKeyStr);
                if (posData) {
                    const WSOL_MINT = 'So11111111111111111111111111111111111111112';
                    if (dlmmPool.tokenX.publicKey.toBase58() !== WSOL_MINT) {
                        tokenBalanceLamports = new BN(posData.positionData.totalXAmount);
                    } else {
                        tokenBalanceLamports = new BN(posData.positionData.totalYAmount);
                    }
                }
            } catch (e) {
                console.log(`[LIVE] Could not check liquidity state: ${e.message}`);
            }

            let mainTxs = [];

            if (hasLiquidity) {
                console.log(`[LIVE] Position has liquidity. Creating removeLiquidity transaction...`);
                const removeTx = await dlmmPool.removeLiquidity({
                    position: positionPubKey,
                    user: walletKeypair.publicKey,
                    fromBinId: closeFromBinId,
                    toBinId: closeToBinId,
                    bps: new BN(10000),
                    shouldClaimAndClose: true
                });
                mainTxs = Array.isArray(removeTx) ? removeTx : [removeTx];
            } else {
                console.log(`[LIVE] No position liquidity detected. Creating closePosition transaction...`);
                const closeTx = await dlmmPool.closePosition({
                    owner: walletKeypair.publicKey,
                    position: { publicKey: positionPubKey }
                });
                mainTxs = Array.isArray(closeTx) ? closeTx : [closeTx];
            }
            
            // 3. Zap Out remaining Meme Tokens
            let zapAttached = false;
            let zapSuccess = false;
            const WSOL_MINT = 'So11111111111111111111111111111111111111112';
            const tokenXStr = dlmmPool.tokenX.publicKey.toBase58();
            const tokenYStr = dlmmPool.tokenY.publicKey.toBase58();
            const inputMintStr = tokenXStr === WSOL_MINT ? tokenYStr : tokenXStr;
            const outputMintStr = WSOL_MINT;

            const inputMint = new PublicKey(inputMintStr);
            const outputMint = new PublicKey(outputMintStr);

            try {
                // For zap out through Jupiter, if we don't have liquidity we might just have tokens in wallet
                // But DLMM Zap Out uses the balance increase. If we had liquidity, tokenBalanceLamports has the amount we expect to receive.
                // If tokenBalanceLamports is 0, let's check wallet balance to be safe, maybe we just want to zap what we already have.
                if (tokenBalanceLamports.lte(new BN(0))) {
                    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(walletKeypair.publicKey, { mint: inputMint });
                    if (tokenAccounts.value.length > 0) {
                        const amountStr = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount;
                        tokenBalanceLamports = new BN(amountStr);
                    }
                }

                if (tokenBalanceLamports.gt(new BN(0))) {
                    console.log(`[LIVE] Expecting ~${tokenBalanceLamports.toString()} lamports of ${inputMintStr}. Preparing atomic Zap Out...`);
                    
                    const { getJupiterQuote, getJupiterSwapInstruction, getTokenProgramFromMint } = require("@meteora-ag/zap-sdk");
                    const zap = new Zap(connection, {
                        jupiterApiUrl: "https://api.jup.ag",
                        jupiterApiKey: process.env.JUPITER_API_KEY || "",
                    });
                    
                    const quote = await getJupiterQuote(
                        inputMint,
                        outputMint,
                        tokenBalanceLamports,
                        40, // maxAccounts
                        50, // slippageBps (0.5%)
                        false, true, true,
                        { jupiterApiKey: process.env.JUPITER_API_KEY || "" }
                    );
                    
                    const swapInstructionResponse = await getJupiterSwapInstruction(walletKeypair.publicKey, quote, {
                        jupiterApiKey: process.env.JUPITER_API_KEY || "",
                    });
                    
                    const inputTokenProgram = await getTokenProgramFromMint(connection, inputMint);
                    const outputTokenProgram = await getTokenProgramFromMint(connection, outputMint);
                    
                    const zapOutTx = await zap.zapOutThroughJupiter({
                        user: walletKeypair.publicKey,
                        inputMint: inputMint,
                        outputMint: outputMint,
                        inputTokenProgram: inputTokenProgram,
                        outputTokenProgram: outputTokenProgram,
                        jupiterSwapResponse: swapInstructionResponse,
                        maxSwapAmount: tokenBalanceLamports,
                        percentageToZapOut: 100 // 100% of the received tokens
                    });

                    // Append Zap Out instructions to the last transaction (the one that actually removes liquidity/closes)
                    const lastTx = mainTxs[mainTxs.length - 1];
                    lastTx.add(zapOutTx);
                    zapAttached = true;
                    console.log(`[LIVE] Zap Out through Jupiter attached to transaction.`);
                }
            } catch (e) {
                console.log(`[LIVE] Zap Out preparation failed: ${e.message}. Proceeding without atomic Zap Out.`);
            }

            try {
                for (let i = 0; i < mainTxs.length; i++) {
                    const tx = mainTxs[i];
                    console.log(`[LIVE] Sending TX ${i+1}/${mainTxs.length}...`);
                    const txid = await rpcRetryWrapper(async () => {
                        const latestBlockHash = await connection.getLatestBlockhash();
                        tx.recentBlockhash = latestBlockHash.blockhash;
                        return await connection.sendTransaction(tx, [walletKeypair]);
                    });
                    txids.push(txid);
                }
                zapSuccess = zapAttached;
            } catch (e) {
                if (zapAttached) {
                    console.log(`[LIVE] Atomic transaction with Zap Out failed: ${e.message}. Retrying with manual fallback...`);
                    txids.length = 0; // reset
                    
                    // Re-create mainTxs without Zap Out
                    if (hasLiquidity) {
                        const removeTx = await dlmmPool.removeLiquidity({
                            position: positionPubKey,
                            user: walletKeypair.publicKey,
                            fromBinId: closeFromBinId,
                            toBinId: closeToBinId,
                            bps: new BN(10000),
                            shouldClaimAndClose: true
                        });
                        mainTxs = Array.isArray(removeTx) ? removeTx : [removeTx];
                    } else {
                        const closeTx = await dlmmPool.closePosition({
                            owner: walletKeypair.publicKey,
                            position: { publicKey: positionPubKey }
                        });
                        mainTxs = Array.isArray(closeTx) ? closeTx : [closeTx];
                    }

                    for (let i = 0; i < mainTxs.length; i++) {
                        const tx = mainTxs[i];
                        console.log(`[LIVE] Sending Fallback TX ${i+1}/${mainTxs.length}...`);
                        const txid = await rpcRetryWrapper(async () => {
                            const latestBlockHash = await connection.getLatestBlockhash();
                            tx.recentBlockhash = latestBlockHash.blockhash;
                            return await connection.sendTransaction(tx, [walletKeypair]);
                        });
                        txids.push(txid);
                    }
                } else {
                    throw e; // Failed for other reasons
                }
            }

            // 4. Fallback Manual Swap if Zap Out wasn't attached or failed
            if (!zapSuccess) {
                try {
                    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(walletKeypair.publicKey, { mint: inputMint });
                    let actualTokenBalance = new BN(0);
                    if (tokenAccounts.value.length > 0) {
                        actualTokenBalance = new BN(tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount);
                    }

                    if (actualTokenBalance.gt(new BN(0))) {
                        console.log(`[LIVE] Fallback: Found ${actualTokenBalance.toString()} of ${inputMintStr}. Swapping via Jupiter API...`);
                        
                        const quoteRes = await fetchWithRetry(`https://api.jup.ag/swap/v1/quote?inputMint=${inputMintStr}&outputMint=${WSOL_MINT}&amount=${actualTokenBalance.toString()}&slippageBps=50`);
                        const quote = await quoteRes.json();

                        if (quote.error) {
                            console.log(`[LIVE] Fallback swap quote error: ${quote.error}`);
                        } else {
                            const swapRes = await fetchWithRetry("https://api.jup.ag/swap/v1/swap", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({
                                    quoteResponse: quote,
                                    userPublicKey: walletKeypair.publicKey.toBase58(),
                                    wrapAndUnwrapSol: true,
                                }),
                            });
                            
                            const swapData = await swapRes.json();
                            if (swapData.swapTransaction) {
                                const swapTransactionBuf = Buffer.from(swapData.swapTransaction, 'base64');
                                let transaction = VersionedTransaction.deserialize(swapTransactionBuf);
                                transaction.sign([walletKeypair]);

                                const rawTransaction = transaction.serialize();
                                const fallbackTxid = await rpcRetryWrapper(async () => {
                                    return await connection.sendRawTransaction(rawTransaction, {
                                        skipPreflight: true,
                                        maxRetries: 2
                                    });
                                });
                                console.log(`[LIVE] Fallback Swap TX: ${fallbackTxid}`);
                                txids.push(fallbackTxid);
                            } else {
                                console.log(`[LIVE] Fallback swap failed to get transaction:`, swapData);
                            }
                        }
                    }
                } catch (e) {
                    console.log(`[LIVE] Fallback swap failed: ${e.message}`);
                }
            }
            
            console.log(`[LIVE] Successfully processed exit for position:`, txids);
            return txids[txids.length - 1] || "success";
        } else {
            console.log(`[DRY RUN] Transaction building skipped to avoid simulation errors on dummy wallet.`);
        }
        return { status: mode === "live" ? "success" : "simulate_success" };
    } catch (e) {
        console.error("Error removing liquidity:", e);
        throw e;
    }
}

async function fetchMeteoraPositionDetails(walletAddress) {
    try {
        const portfolioUrl = `https://dlmm.datapi.meteora.ag/portfolio/open?user=${walletAddress}`;
        const res = await fetchWithRetry(portfolioUrl);
        if (!res.ok) {
            console.log(`[Meteora API] Failed to fetch portfolio: HTTP ${res.status}`);
            return null;
        }
        const portfolio = await res.json();
        const pools = portfolio.pools || [];
        
        const detailsMap = {};
        
        for (const pool of pools) {
            try {
                const pnlUrl = `https://dlmm.datapi.meteora.ag/positions/${pool.poolAddress}/pnl?user=${walletAddress}&status=open`;
                const pnlRes = await fetchWithRetry(pnlUrl);
                if (pnlRes.ok) {
                    const pnlData = await pnlRes.json();
                    const positions = pnlData.positions || [];
                    for (const p of positions) {
                        const isOOR = p.isOutOfRange || false;
                        const unclaimedUsdX = parseFloat(p.unrealizedPnl?.unclaimedFeeTokenX?.usd || 0);
                        const unclaimedUsdY = parseFloat(p.unrealizedPnl?.unclaimedFeeTokenY?.usd || 0);
                        const balancesUsd = parseFloat(p.unrealizedPnl?.balances || 0);
                        const pnlUsd = parseFloat(p.pnlUsd || 0);
                        const pnlPctChange = parseFloat(p.pnlPctChange || p.pnlSolPctChange || 0);

                        detailsMap[p.positionAddress] = {
                            inRange: !isOOR,
                            pnlPct: pnlPctChange,
                            pnlUsd: pnlUsd,
                            totalValueUsd: balancesUsd,
                            unclaimedFeesUsd: unclaimedUsdX + unclaimedUsdY
                        };
                    }
                }
            } catch (e) {
                console.log(`[Meteora API] Failed to fetch PnL for pool ${pool.poolAddress}`);
            }
        }
        
        return detailsMap;
    } catch (e) {
        console.error("[Meteora API] Error fetching position details:", e.message);
        return null;
    }
}

module.exports = {
    swapSolToToken,
    swapTokenToSol,
    getSolPriceUsd,
    fetchMeteoraPools,
    addLiquidity,
    removeLiquidity,
    fetchMeteoraPositionDetails
};

async function syncManualPositions(connection, walletKeypair) {
    const { readState, saveState } = require('./state.cjs');
    const { fetchWithRetry } = require('./api-utils.cjs');
    
    console.log(`[Sync] Scanning RPC for active DLMM positions owned by wallet...`);
    const lbclmmProgramId = new PublicKey(DLMM.LBCLMM_PROGRAM_IDS['mainnet-beta']);
    
    try {
        const accounts = await connection.getProgramAccounts(lbclmmProgramId, {
            filters: [DLMM.positionOwnerFilter(walletKeypair.publicKey)],
            commitment: 'confirmed'
        });
        
        const state = readState();
        let addedCount = 0;
        let syncedPositions = [];
        
        for (const accountInfo of accounts) {
            try {
                let lbPair = new PublicKey(accountInfo.account.data.slice(8, 40));
                const positionPubKeyStr = accountInfo.pubkey.toBase58();
                
                // Check if already in state
                if (state.find(p => p.positionPubKey === positionPubKeyStr)) continue;
                
                const poolInstance = await DLMM.create(connection, lbPair, { cluster: "mainnet-beta" });
                const activeBin = await poolInstance.getActiveBin();
                
                const WSOL_MINT = 'So11111111111111111111111111111111111111112';
                let tokenMintStr = poolInstance.tokenX.publicKey.toBase58();
                if (tokenMintStr === WSOL_MINT) {
                    tokenMintStr = poolInstance.tokenY.publicKey.toBase58();
                }
                
                // Fetch Symbol and USD price
                let tokenSymbol = "MANUAL";
                let entryPriceUsd = 0;
                try {
                    const res = await fetchWithRetry(`https://api.dexscreener.com/latest/dex/tokens/${tokenMintStr}`);
                    if (res.ok) {
                        const data = await res.json();
                        if (data && data.pairs && data.pairs.length > 0) {
                            const pair = data.pairs[0];
                            tokenSymbol = pair.baseToken.address === tokenMintStr ? pair.baseToken.symbol : pair.quoteToken.symbol;
                            entryPriceUsd = parseFloat(pair.priceUsd) || 0;
                        }
                    }
                } catch(e) {}
                
                // Fetch invested SOL
                let investedSol = 0;
                try {
                    const solPrice = await module.exports.getSolPriceUsd() || 150;
                    const { userPositions } = await poolInstance.getPositionsByUserAndLbPair(walletKeypair.publicKey);
                    const posData = userPositions.find(p => p.publicKey.toBase58() === positionPubKeyStr);
                    
                    if (posData) {
                        const xAmount = Number(posData.positionData.totalXAmount) / Math.pow(10, poolInstance.tokenX.mint.decimals);
                        const yAmount = Number(posData.positionData.totalYAmount) / Math.pow(10, poolInstance.tokenY.mint.decimals);
                        
                        let totalUsd = 0;
                        if (poolInstance.tokenX.publicKey.toBase58() === WSOL_MINT) {
                            totalUsd = (xAmount * solPrice) + (yAmount * entryPriceUsd);
                        } else {
                            totalUsd = (yAmount * solPrice) + (xAmount * entryPriceUsd);
                        }
                        investedSol = totalUsd / solPrice;
                    }
                } catch(e) {
                    console.log(`[Sync] Warning calculating invested:`, e.message);
                }
                
                let minBinId, maxBinId;
                try {
                    const posAccount = await poolInstance.program.account.positionV2.fetch(new PublicKey(positionPubKeyStr));
                    minBinId = posAccount.lowerBinId;
                    maxBinId = posAccount.upperBinId;
                } catch(e) {
                    console.log(`[Sync] Failed to fetch bin bounds:`, e.message);
                }

                const newPos = {
                    positionPubKey: positionPubKeyStr,
                    poolAddress: lbPair.toBase58(),
                    tokenMint: tokenMintStr,
                    tokenSymbol: tokenSymbol,
                    openedBy: "manual",
                    investedSol: investedSol,
                    entryBinPrice: activeBin.price,
                    entryPriceUsd: entryPriceUsd,
                    minBinId: minBinId,
                    maxBinId: maxBinId,
                    timestamp: Date.now()
                };
                
                state.push(newPos);
                syncedPositions.push(newPos);
                addedCount++;
                console.log(`[Sync] Injected manual position: ${positionPubKeyStr} for token ${tokenSymbol}`);
            } catch(e) {
                // continue
            }
        }
        
        if (addedCount > 0) {
            saveState(state);
            console.log(`[Sync] Added ${addedCount} manual positions to active state.`);
        }
        return syncedPositions;
    } catch(e) {
        console.error(`[Sync Error]`, e.message);
        return [];
    }
}

module.exports.syncManualPositions = syncManualPositions;
