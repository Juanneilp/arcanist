const { PublicKey, VersionedTransaction, ComputeBudgetProgram, sendAndConfirmTransaction } = require('@solana/web3.js');
const DLMM = require('@meteora-ag/dlmm');
const { Zap } = require('@meteora-ag/zap-sdk');
const BN = require('bn.js');
const { fetchWithRetry, rpcRetryWrapper } = require('./api-utils.cjs');

// --- METEORA LOGIC ---
function resolveStrategyType(type) {
    if (typeof type === 'number') return type;
    if (typeof type === 'string') {
        const lower = type.toLowerCase();
        if (lower === 'curve') return 1;
        if (lower === 'bid-ask' || lower === 'bidask') return 2;
    }
    return 0; // Default to Spot
}
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
                base_fee_pct: p.base_fee_pct ?? p.pool_config?.base_fee_pct ?? p.dlmm_params?.base_fee_pct ?? 0,
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

    let strategiesToExecute = [];
    if (strategyOptions.type === 'mix') {
        const configPath = path.join(__dirname, '..', 'user-config.json');
        let mixedConf = [{ type: 'spot', percent: 50 }, { type: 'bid-ask', percent: 50 }];
        try {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            if (config.meteoraConfig && config.meteoraConfig.mixedStrategies) {
                mixedConf = config.meteoraConfig.mixedStrategies;
            }
        } catch(e) {}
        
        for (const strat of mixedConf) {
            const ratio = (strat.percent || 50) / 100;
            const lamportsPart = Math.floor(solLamports * ratio);
            let partX = new BN(0), partY = new BN(0);
            if (isSolX) partX = new BN(lamportsPart);
            else partY = new BN(lamportsPart);
            
            strategiesToExecute.push({
                type: strat.type,
                xAmount: partX,
                yAmount: partY,
                lamports: lamportsPart
            });
        }
    } else {
        strategiesToExecute.push({
            type: strategyOptions.type,
            xAmount: newBalanceX,
            yAmount: newBalanceY,
            lamports: solLamports
        });
    }

    console.log(`[INFO] Configured Strategies to Execute:`);
    strategiesToExecute.forEach((s, idx) => {
        const solVal = (s.lamports / 1e9).toFixed(4);
        console.log(`  -> Strategy ${idx+1}: ${s.type} | Amount: ${solVal} SOL`);
    });

    try {
        console.log(`[QUOTE] Checking for non-refundable costs...`);
        const quote = await dlmmPool.quoteCreatePosition({
            strategy: {
                maxBinId: maxBin,
                minBinId: minBin,
                strategyType: resolveStrategyType(strategiesToExecute[0].type)
            }
        });

        // SDK may return BN (lamports) or plain number (SOL) — normalize to number (SOL)
        function toSolValue(val) {
            if (val === undefined || val === null) return 0;
            if (BN.isBN(val)) return val.toNumber() / 1e9;
            if (typeof val === 'number') return val;
            if (typeof val === 'string') return parseFloat(val) || 0;
            return 0;
        }

        const binArrayCostSol = toSolValue(quote.binArrayCost);
        const binArrayCount = quote.binArrayCount ?? quote.binArraysCount ?? 0;
        const positionRentSol = toSolValue(quote.positionRent || quote.positionCost);
        const reallocCostSol = toSolValue(quote.reallocCost || quote.positionReallocCost);
        const bitmapExtCostSol = toSolValue(quote.bitmapExtensionCost);

        console.log(`[QUOTE] Position count: ${quote.positionCount ?? 1}`);
        console.log(`[QUOTE] Position rent (refundable): ${positionRentSol.toFixed(6)} SOL`);
        console.log(`[QUOTE] Realloc cost (refundable): ${reallocCostSol.toFixed(6)} SOL`);
        console.log(`[QUOTE] Bitmap ext cost (refundable): ${bitmapExtCostSol.toFixed(6)} SOL`);
        console.log(`[QUOTE] BinArray count (NON-refundable): ${binArrayCount}`);
        console.log(`[QUOTE] BinArray cost (NON-refundable): ${binArrayCostSol.toFixed(6)} SOL`);

        if (binArrayCount > 0 || binArrayCostSol > 0) {
            console.log(`[SKIP] Skipping deploy: Non-refundable binArray cost detected! ${binArrayCount} binArray(s) = ~${binArrayCostSol.toFixed(4)} SOL`);
            return {
                status: "skipped",
                reason: "non_refundable_cost",
                binArrayCount: binArrayCount,
                cost: binArrayCostSol
            };
        }
        console.log(`[QUOTE] Safe to deploy! No non-refundable cost.`);

        if (mode === "live") {
            const totalSetupCostSol = positionRentSol + reallocCostSol + bitmapExtCostSol;
            // gas buffer 0.005 SOL to cover priority fees and base fees for multiple txs
            const gasBufferSol = 0.005;
            const requiredSol = (solLamports / 1e9) + totalSetupCostSol + gasBufferSol;
            
            const currentBalance = await connection.getBalance(walletKeypair.publicKey);
            const currentBalanceSol = currentBalance / 1e9;
            if (currentBalanceSol < requiredSol) {
                console.log(`[SKIP] Skipping deploy: Insufficient balance to cover liquidity + setup costs! Needed: ~${requiredSol.toFixed(4)} SOL, Wallet: ${currentBalanceSol.toFixed(4)} SOL`);
                return {
                    status: "skipped",
                    reason: "insufficient_balance",
                    requiredSol: requiredSol,
                    currentBalanceSol: currentBalanceSol
                };
            }
            const firstStrat = strategiesToExecute[0];
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
                        return await sendAndConfirmTransaction(connection, createTxArray[0], [walletKeypair, newPositionKeypair], { skipPreflight: true });
                    });
                    console.log(`[LIVE] Create Position TX 1/${createTxArray.length} Confirmed. TXID: ${txid0}`);
                }

                if (createTxArray.length > 1) {
                    console.log(`[LIVE] Sending remaining ${createTxArray.length - 1} Create Bin Array TXs in parallel...`);
                    const remainingCreatePromises = createTxArray.slice(1).map((tx, idx) => {
                        if (typeof tx.add === 'function') tx.instructions.unshift(priorityFeeIx);
                        return rpcRetryWrapper(async () => {
                            return await sendAndConfirmTransaction(connection, tx, [walletKeypair], { skipPreflight: true });
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

                const firstSolVal = (firstStrat.lamports / 1e9).toFixed(4);
                console.log(`[LIVE] Sending Add Liquidity (Chunkable) transaction(s) for Strategy 1: ${firstStrat.type} (${firstSolVal} SOL)...`);
                const addTxs = await dlmmPool.addLiquidityByStrategyChunkable({
                    positionPubKey: newPositionKeypair.publicKey,
                    user: walletKeypair.publicKey,
                    totalXAmount: firstStrat.xAmount,
                    totalYAmount: firstStrat.yAmount,
                    strategy: {
                        maxBinId: maxBin,
                        minBinId: minBin,
                        strategyType: resolveStrategyType(firstStrat.type)
                    },
                    slippage: 10 // 10%
                });

                const addTxArray = Array.isArray(addTxs) ? addTxs : [addTxs];
                console.log(`[LIVE] Sending ${addTxArray.length} Add Liquidity TXs in parallel...`);
                const addPromises = addTxArray.map((tx, idx) => {
                    if (typeof tx.add === 'function') tx.instructions.unshift(priorityFeeIx);
                    return rpcRetryWrapper(async () => {
                        return await sendAndConfirmTransaction(connection, tx, [walletKeypair], { skipPreflight: true });
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
                    totalXAmount: firstStrat.xAmount,
                    totalYAmount: firstStrat.yAmount,
                    strategy: {
                        maxBinId: maxBin,
                        minBinId: minBin,
                        strategyType: resolveStrategyType(firstStrat.type)
                    },
                    slippage: 1000 // 10% in bps
                });

                const firstSolVal = (firstStrat.lamports / 1e9).toFixed(4);
                console.log(`[LIVE] Sending Add Liquidity transaction for Strategy 1: ${firstStrat.type} (${firstSolVal} SOL)...`);
                if (typeof createPositionTx.add === 'function') createPositionTx.instructions.unshift(priorityFeeIx);
                const txid = await rpcRetryWrapper(async () => {
                    return await sendAndConfirmTransaction(connection, createPositionTx, [walletKeypair, newPositionKeypair], { skipPreflight: true });
                });
                console.log(`[LIVE] Transaction Confirmed. TXID: ${txid}`);
            }

            for (let i = 1; i < strategiesToExecute.length; i++) {
                const strat = strategiesToExecute[i];
                const stratSolVal = (strat.lamports / 1e9).toFixed(4);
                console.log(`[LIVE] Sending additional Add Liquidity for Strategy ${i+1}: ${strat.type} (${stratSolVal} SOL)...`);
                try {
                    const addTxs = await dlmmPool.addLiquidityByStrategyChunkable({
                        positionPubKey: newPositionKeypair.publicKey,
                        user: walletKeypair.publicKey,
                        totalXAmount: strat.xAmount,
                        totalYAmount: strat.yAmount,
                        strategy: {
                            maxBinId: maxBin,
                            minBinId: minBin,
                            strategyType: resolveStrategyType(strat.type)
                        },
                        slippage: 10
                    });

                    const addTxArray = Array.isArray(addTxs) ? addTxs : [addTxs];
                    for (const tx of addTxArray) {
                        if (typeof tx.add === 'function') tx.instructions.unshift(priorityFeeIx);
                        const retryWrapper = async () => {
                            let attempts = 0;
                            while (attempts < 3) {
                                try {
                                    return await sendAndConfirmTransaction(connection, tx, [walletKeypair], { skipPreflight: true });
                                } catch (e) {
                                    attempts++;
                                    console.log(`[LIVE] Add Liquidity retry ${attempts}/3 failed: ${e.message}`);
                                    if (attempts >= 3) throw e;
                                    await new Promise(r => setTimeout(r, 2000));
                                }
                            }
                        };
                        const txid = await retryWrapper();
                        console.log(`[LIVE] Strategy ${i+1} (${strat.type}) Confirmed. TXID: ${txid}`);
                    }
                } catch (e) {
                    console.error(`[LIVE] Failed to add liquidity for Strategy ${i+1} (${strat.type}):`, e.message);
                    // Continue without aborting the whole position since the first part was already deployed
                }
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
                    console.log(`[LIVE] Position ${positionPubKeyStr} has liquidity. Creating removeLiquidity transaction...`);
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
                    console.log(`[LIVE] No liquidity detected in ${positionPubKeyStr}. Creating closePosition transaction...`);
                    const closeTx = await dlmmPool.closePosition({
                        owner: walletKeypair.publicKey,
                        position: { publicKey: positionPubKey }
                    });
                    mainTxs = Array.isArray(closeTx) ? closeTx : [closeTx];
                }
            } catch (err) {
                const errorText = (err.message || '') + ' ' + (err.logs ? JSON.stringify(err.logs) : '') + ' ' + (err.toString ? err.toString() : '');
                if (errorText.includes('0xbbf') || errorText.includes('3007') || errorText.includes('AccountOwnedByWrongProgram')) {
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
                    console.log(`[LIVE] Expecting ~${tokenBalanceLamports.toString()} lamports of ${inputMintStr}. Bypassing atomic Zap Out for faster 2-step execution...`);
                    // We skip atomic Zap Out because it is too heavy and often fails with "Block height exceeded".
                    // The Fallback Manual Swap logic below will handle swapping the returned tokens.
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
                        return await sendAndConfirmTransaction(connection, tx, [walletKeypair], { skipPreflight: true });
                    });
                    txids.push(txid);
                }
                zapSuccess = zapAttached;
            } catch (e) {
                const errorText = (e.message || '') + ' ' + (e.logs ? JSON.stringify(e.logs) : '') + ' ' + (e.toString ? e.toString() : '');
                if (errorText.includes('0xbbf') || errorText.includes('3007') || errorText.includes('AccountOwnedByWrongProgram')) {
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
                        const errorText = (err.message || '') + ' ' + (err.logs ? JSON.stringify(err.logs) : '') + ' ' + (err.toString ? err.toString() : '');
                        if (errorText.includes('0xbbf') || errorText.includes('3007') || errorText.includes('AccountOwnedByWrongProgram')) {
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
                            return await sendAndConfirmTransaction(connection, tx, [walletKeypair], { skipPreflight: true });
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
                                        skipPreflight: true
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

            console.log(`[LIVE] Successfully processed exit and closed position: ${positionPubKeyStr}. TXIDs:`, txids);

            return {
                status: "success",
                txids: txids
            };
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

async function claimFees(connection, walletKeypair, poolAddress, positionPubKey, botMode = "live") {
    console.log(`[Claim Fees] Initiating claim for position ${positionPubKey} in pool ${poolAddress}`);
    if (botMode === "dry_run") {
        console.log(`[DRY RUN] Claim fees simulated for ${positionPubKey}`);
        return true;
    }
    
    try {
        const DLMM = require('@meteora-ag/dlmm').default || require('@meteora-ag/dlmm');
        const dlmmPool = await DLMM.create(connection, new PublicKey(poolAddress), { cluster: "mainnet-beta" });
        
        const txs = await dlmmPool.claimSwapFee({
            owner: walletKeypair.publicKey,
            position: new PublicKey(positionPubKey),
        });
        
        let success = true;
        const mainTxs = Array.isArray(txs) ? txs : [txs];
        const priorityFeeIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 250000 });
        
        for (let i = 0; i < mainTxs.length; i++) {
            const tx = mainTxs[i];
            console.log(`[LIVE] Sending Claim TX ${i + 1}/${mainTxs.length}...`);
            try {
                if (typeof tx.add === 'function') tx.instructions.unshift(priorityFeeIx);
                const txid = await rpcRetryWrapper(async () => {
                    return await sendAndConfirmTransaction(connection, tx, [walletKeypair], { skipPreflight: true });
                });
                console.log(`[LIVE] Claim TX ${i + 1} confirmed: ${txid}`);
            } catch (err) {
                console.error(`[LIVE] Error confirming Claim TX ${i + 1}:`, err.message);
                success = false;
            }
        }
        return success;
    } catch (e) {
        console.error(`[Claim Fees Error] Failed to claim fees for ${positionPubKey}:`, e.message);
        return false;
    }
}

module.exports = {
    fetchMeteoraPools,
    addLiquidity,
    removeLiquidity,
    fetchMeteoraPositionDetails,
    claimFees
};
