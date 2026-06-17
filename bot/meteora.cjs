const { PublicKey, VersionedTransaction, ComputeBudgetProgram } = require('@solana/web3.js');
const DLMM = require('@meteora-ag/dlmm');
const { Zap } = require('@meteora-ag/zap-sdk');
const BN = require('bn.js');
const { fetchWithRetry, rpcRetryWrapper } = require('./api-utils.cjs');

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

        let matchingPools = pools.map(p => {
            const fees_1h = p.fees ? parseFloat(p.fees["1h"] || 0) : 0;
            return {
                address: p.address || p.pool_address,
                poolAddress: p.address || p.pool_address,
                name: p.name,
                bin_step: p.bin_step ?? p.dlmm_params?.bin_step ?? p.pool_config?.bin_step,
                liquidity: p.liquidity ?? p.tvl,
                mint_x: p.mint_x ?? p.token_x?.address,
                mint_y: p.mint_y ?? p.token_y?.address,
                symbol_x: p.mint_x_symbol ?? p.token_x?.symbol,
                symbol_y: p.mint_y_symbol ?? p.token_y?.symbol,
                fees_1h: fees_1h,
                avg_fees_per_min: fees_1h / 60
            };
        });

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
    const fs = require('fs');
    const path = require('path');
    let priorityFeeMicroLamports = 100000;
    try {
        const configPath = path.join(__dirname, '..', 'user-config.json');
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        priorityFeeMicroLamports = config.meteoraConfig?.priorityFeeMicroLamports || 100000;
    } catch(e) {}
    const priorityFeeIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports });

    const poolAddress = new PublicKey(poolAddressStr);
    console.log(`Initializing DLMM Pool instance for ${poolAddressStr}...`);
    const dlmmPool = await DLMM.create(connection, poolAddress, { cluster: "mainnet-beta" });

    const activeBin = await dlmmPool.getActiveBin();
    console.log(`Current Active Bin Price: ${activeBin.price}`);

    const isSolX = dlmmPool.tokenX.publicKey.toBase58() === solMint;
    let minBin, maxBin, newBalanceX, newBalanceY;

    const currentRawPrice = Number(activeBin.price);

    const minPrice = currentRawPrice * (1 + (minRange / 100));
    const maxPrice = currentRawPrice * (1 + (maxRange / 100));

    const rawMinBin = dlmmPool.getBinIdFromPrice(minPrice, true);
    const rawMaxBin = dlmmPool.getBinIdFromPrice(maxPrice, false);

    if (isSolX) {
        const sortedMin = Math.min(rawMinBin, rawMaxBin);
        const sortedMax = Math.max(rawMinBin, rawMaxBin);
        minBin = Math.max(sortedMin, activeBin.binId);
        maxBin = Math.max(sortedMax, activeBin.binId);

        newBalanceX = new BN(solLamports);
        newBalanceY = new BN(0);
    } else {
        const sortedMin = Math.min(rawMinBin, rawMaxBin);
        const sortedMax = Math.max(rawMinBin, rawMaxBin);
        minBin = Math.min(sortedMin, activeBin.binId);
        maxBin = Math.min(sortedMax, activeBin.binId);

        newBalanceX = new BN(0);
        newBalanceY = new BN(solLamports);
    }

    const { Keypair } = require('@solana/web3.js');
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

                if (createTxArray.length > 0) {
                    if (typeof createTxArray[0].add === 'function') createTxArray[0].instructions.unshift(priorityFeeIx);
                    const txid0 = await rpcRetryWrapper(async () => {
                        const latestBlockHash = await connection.getLatestBlockhash();
                        createTxArray[0].recentBlockhash = latestBlockHash.blockhash;
                        const sig = await connection.sendTransaction(createTxArray[0], [walletKeypair, newPositionKeypair], { skipPreflight: true, maxRetries: 2 });
                        await connection.confirmTransaction({
                            signature: sig,
                            blockhash: latestBlockHash.blockhash,
                            lastValidBlockHeight: latestBlockHash.lastValidBlockHeight
                        }, "confirmed");
                        return sig;
                    });
                    console.log(`[LIVE] Create Position TX 1/${createTxArray.length} Confirmed. TXID: ${txid0}`);
                }

                if (createTxArray.length > 1) {
                    console.log(`[LIVE] Sending remaining ${createTxArray.length - 1} Create Bin Array TXs in parallel...`);
                    const remainingCreatePromises = createTxArray.slice(1).map((tx, idx) => {
                        if (typeof tx.add === 'function') tx.instructions.unshift(priorityFeeIx);
                        return rpcRetryWrapper(async () => {
                            const latestBlockHash = await connection.getLatestBlockhash();
                            tx.recentBlockhash = latestBlockHash.blockhash;
                            const sig = await connection.sendTransaction(tx, [walletKeypair], { skipPreflight: true, maxRetries: 2 });
                            await connection.confirmTransaction({
                                signature: sig,
                                blockhash: latestBlockHash.blockhash,
                                lastValidBlockHeight: latestBlockHash.lastValidBlockHeight
                            }, "confirmed");
                            return sig;
                        });
                    });

                    const createResults = await Promise.allSettled(remainingCreatePromises);
                    createResults.forEach((res, idx) => {
                        if (res.status === 'fulfilled') {
                            console.log(`[LIVE] Create Bin Array TX ${idx + 2}/${createTxArray.length} Confirmed. TXID: ${res.value}`);
                        } else {
                            console.error(`[LIVE] Create Bin Array TX ${idx + 2}/${createTxArray.length} Failed:`, res.reason);
                            throw res.reason;
                        }
                    });
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
                console.log(`[LIVE] Sending ${addTxArray.length} Add Liquidity TXs in parallel...`);
                const addPromises = addTxArray.map((tx, idx) => {
                    if (typeof tx.add === 'function') tx.instructions.unshift(priorityFeeIx);
                    return rpcRetryWrapper(async () => {
                        const latestBlockHash = await connection.getLatestBlockhash();
                        tx.recentBlockhash = latestBlockHash.blockhash;
                        const sig = await connection.sendTransaction(tx, [walletKeypair], { skipPreflight: true, maxRetries: 2 });
                        await connection.confirmTransaction({
                            signature: sig,
                            blockhash: latestBlockHash.blockhash,
                            lastValidBlockHeight: latestBlockHash.lastValidBlockHeight
                        }, "confirmed");
                        return sig;
                    });
                });

                const addResults = await Promise.allSettled(addPromises);
                addResults.forEach((res, idx) => {
                    if (res.status === 'fulfilled') {
                        console.log(`[LIVE] Add Liquidity TX ${idx + 1}/${addTxArray.length} Confirmed. TXID: ${res.value}`);
                    } else {
                        console.error(`[LIVE] Add Liquidity TX ${idx + 1}/${addTxArray.length} Failed:`, res.reason);
                        throw res.reason;
                    }
                });
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
                if (typeof createPositionTx.add === 'function') createPositionTx.instructions.unshift(priorityFeeIx);
                const txid = await rpcRetryWrapper(async () => {
                    const latestBlockHash = await connection.getLatestBlockhash();
                    createPositionTx.recentBlockhash = latestBlockHash.blockhash;
                    const sig = await connection.sendTransaction(createPositionTx, [walletKeypair, newPositionKeypair], { skipPreflight: true, maxRetries: 2 });
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
    const fs = require('fs');
    const path = require('path');
    let priorityFeeMicroLamports = 100000;
    try {
        const configPath = path.join(__dirname, '..', 'user-config.json');
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        priorityFeeMicroLamports = config.meteoraConfig?.priorityFeeMicroLamports || 100000;
    } catch(e) {}
    const priorityFeeIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports });

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
                const posAccountInfo = await connection.getAccountInfo(positionPubKey);
                if (!posAccountInfo || posAccountInfo.owner.toBase58() === "11111111111111111111111111111111") {
                    console.log(`[LIVE] Position account ${positionPubKeyStr} not found or already closed. Skipping removeLiquidity.`);
                    return "already_closed";
                }

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
                        tokenBalanceLamports = new BN(posData.positionData.totalXAmount).add(new BN(posData.positionData.feeX));
                    } else {
                        tokenBalanceLamports = new BN(posData.positionData.totalYAmount).add(new BN(posData.positionData.feeY));
                    }
                }
            } catch (e) {
                console.log(`[LIVE] Could not check liquidity state: ${e.message}`);
            }

            let mainTxs = [];

            try {
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
            } catch (err) {
                if (err.message && (err.message.includes('0xbbf') || err.message.includes('3007') || err.message.includes('AccountOwnedByWrongProgram'))) {
                    console.log(`[LIVE] Caught simulation error 3007 for ${positionPubKeyStr}. Treating as already closed.`);
                    return "already_closed";
                }
                throw err;
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

                    mainTxs.push(zapOutTx);
                    zapAttached = true;
                    console.log(`[LIVE] Zap Out through Jupiter appended as separate transaction.`);
                }
            } catch (e) {
                console.log(`[LIVE] Zap Out preparation failed: ${e.message}. Proceeding without atomic Zap Out.`);
            }

            try {
                for (let i = 0; i < mainTxs.length; i++) {
                    const tx = mainTxs[i];
                    console.log(`[LIVE] Sending TX ${i + 1}/${mainTxs.length}...`);
                    if (typeof tx.add === 'function') tx.instructions.unshift(priorityFeeIx);
                    const txid = await rpcRetryWrapper(async () => {
                        const latestBlockHash = await connection.getLatestBlockhash();
                        tx.recentBlockhash = latestBlockHash.blockhash;
                        const sig = await connection.sendTransaction(tx, [walletKeypair], { skipPreflight: true, maxRetries: 2 });
                        await connection.confirmTransaction({
                            signature: sig,
                            blockhash: latestBlockHash.blockhash,
                            lastValidBlockHeight: latestBlockHash.lastValidBlockHeight
                        }, "confirmed");
                        return sig;
                    });
                    txids.push(txid);
                }
                zapSuccess = zapAttached;
            } catch (e) {
                if (e.message && (e.message.includes('0xbbf') || e.message.includes('3007') || e.message.includes('AccountOwnedByWrongProgram'))) {
                    console.log(`[LIVE] Caught error 3007 during TX send for ${positionPubKeyStr}. Treating as already closed.`);
                    return "already_closed";
                }

                if (zapAttached) {
                    console.log(`[LIVE] Atomic transaction with Zap Out failed: ${e.message}. Retrying with manual fallback...`);
                    txids.length = 0; // reset

                    try {
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
                    } catch (err) {
                        if (err.message && (err.message.includes('0xbbf') || err.message.includes('3007') || err.message.includes('AccountOwnedByWrongProgram'))) {
                            console.log(`[LIVE] Caught simulation error 3007 during fallback for ${positionPubKeyStr}. Treating as already closed.`);
                            return "already_closed";
                        }
                        throw err;
                    }

                    for (let i = 0; i < mainTxs.length; i++) {
                        const tx = mainTxs[i];
                        console.log(`[LIVE] Sending Fallback TX ${i + 1}/${mainTxs.length}...`);
                        if (typeof tx.add === 'function') tx.instructions.unshift(priorityFeeIx);
                        const txid = await rpcRetryWrapper(async () => {
                            const latestBlockHash = await connection.getLatestBlockhash();
                            tx.recentBlockhash = latestBlockHash.blockhash;
                            const sig = await connection.sendTransaction(tx, [walletKeypair], { skipPreflight: true, maxRetries: 2 });
                            await connection.confirmTransaction({
                                signature: sig,
                                blockhash: latestBlockHash.blockhash,
                                lastValidBlockHeight: latestBlockHash.lastValidBlockHeight
                            }, "confirmed");
                            return sig;
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
                                const latestBlockHash = await connection.getLatestBlockhash();
                                const fallbackTxid = await rpcRetryWrapper(async () => {
                                    const sig = await connection.sendRawTransaction(rawTransaction, {
                                        skipPreflight: true,
                                        maxRetries: 2
                                    });
                                    await connection.confirmTransaction({
                                        signature: sig,
                                        blockhash: latestBlockHash.blockhash,
                                        lastValidBlockHeight: latestBlockHash.lastValidBlockHeight
                                    }, "confirmed");
                                    return sig;
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
    fetchMeteoraPools,
    addLiquidity,
    removeLiquidity,
    fetchMeteoraPositionDetails
};
