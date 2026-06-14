const { PublicKey, Connection, Keypair, VersionedTransaction, TransactionMessage, Transaction } = require('@solana/web3.js');
const DLMM = require('@meteora-ag/dlmm');
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
        const response = await fetchWithRetry("https://price.jup.ag/v6/price?ids=SOL");
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
    
    // Solana inner instruction reallocation limit allows max ~69 bins in a single InitializePosition transaction.
    // Also, the overall transaction size limit is 1232 bytes, which means we cannot bundle >69 bins into 1 transaction either.
    if (maxBin - minBin > 69) {
        console.warn(`[Warning] Range width (${maxBin - minBin} bins) exceeds single TX limit (69 bins). Capping range.`);
        if (isSolX) {
            maxBin = minBin + 69;
        } else {
            minBin = maxBin - 69;
        }
    }
    
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
                },
                slippage: 1000 // 10% in bps
            });
            
            console.log(`[LIVE] Sending Add Liquidity transaction...`);
            const txid = await rpcRetryWrapper(async () => {
                const latestBlockHash = await connection.getLatestBlockhash();
                createPositionTx.recentBlockhash = latestBlockHash.blockhash;
                return await connection.sendTransaction(createPositionTx, [walletKeypair, newPositionKeypair]);
            });
            console.log(`[LIVE] Transaction Sent. TXID: ${txid}`);
        } else {
            console.log(`[DRY RUN] Transaction building skipped to avoid simulation errors on dummy wallet.`);
        }
        
        return { 
            status: mode === "live" ? "success" : "simulate_success", 
            positionPubKey: newPositionKeypair.publicKey.toBase58(),
            activeBinPrice: activeBin.price
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
    
    try {
        if (mode === "live") {
            const txids = [];
            
            // 1. Claim Fees
            try {
                console.log(`[LIVE] Attempting to claim fees for position ${positionPubKeyStr}...`);
                const positionData = await dlmmPool.getPosition(positionPubKey);
                const claimTxs = await dlmmPool.claimSwapFee({
                    owner: walletKeypair.publicKey,
                    position: positionData
                });
                
                if (claimTxs && claimTxs.length > 0) {
                    for (const tx of claimTxs) {
                        const txid = await rpcRetryWrapper(async () => {
                            const latestBlockHash = await connection.getLatestBlockhash();
                            tx.recentBlockhash = latestBlockHash.blockhash;
                            return await connection.sendTransaction(tx, [walletKeypair]);
                        });
                        txids.push(txid);
                    }
                    console.log(`[LIVE] Claim Fees TXs:`, txids);
                }
            } catch (e) {
                console.log(`[LIVE] Claim fees skipped or failed: ${e.message}`);
            }

            // 2. Remove Liquidity & Close
            let hasLiquidity = false;
            let closeFromBinId = -887272;
            let closeToBinId = 887272;
            try {
                const positionData = await dlmmPool.getPosition(positionPubKey);
                if (positionData && positionData.positionData) {
                    const pd = positionData.positionData;
                    closeFromBinId = pd.lowerBinId ?? closeFromBinId;
                    closeToBinId = pd.upperBinId ?? closeToBinId;
                    const bins = Array.isArray(pd.positionBinData) ? pd.positionBinData : [];
                    hasLiquidity = bins.some(bin => new BN(bin.positionLiquidity || "0").gt(new BN(0)));
                }
            } catch (e) {
                console.log(`[LIVE] Could not check liquidity state: ${e.message}`);
            }

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
                
                const txs = Array.isArray(removeTx) ? removeTx : [removeTx];
                for (let i = 0; i < txs.length; i++) {
                    const tx = txs[i];
                    console.log(`[LIVE] Sending Remove TX ${i+1}/${txs.length}...`);
                    const txid = await rpcRetryWrapper(async () => {
                        const latestBlockHash = await connection.getLatestBlockhash();
                        tx.recentBlockhash = latestBlockHash.blockhash;
                        return await connection.sendTransaction(tx, [walletKeypair]);
                    });
                    txids.push(txid);
                }
            } else {
                console.log(`[LIVE] No position liquidity detected. Creating closePosition transaction...`);
                const closeTx = await dlmmPool.closePosition({
                    owner: walletKeypair.publicKey,
                    position: { publicKey: positionPubKey }
                });
                
                const txs = Array.isArray(closeTx) ? closeTx : [closeTx];
                for (let i = 0; i < txs.length; i++) {
                    const tx = txs[i];
                    console.log(`[LIVE] Sending Close TX ${i+1}/${txs.length}...`);
                    const txid = await rpcRetryWrapper(async () => {
                        const latestBlockHash = await connection.getLatestBlockhash();
                        tx.recentBlockhash = latestBlockHash.blockhash;
                        return await connection.sendTransaction(tx, [walletKeypair]);
                    });
                    txids.push(txid);
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
                
                const poolInstance = await DLMM.create(connection, lbPair);
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
                
                const newPos = {
                    positionPubKey: positionPubKeyStr,
                    poolAddress: lbPair.toBase58(),
                    tokenMint: tokenMintStr,
                    tokenSymbol: tokenSymbol,
                    openedBy: "manual",
                    investedSol: investedSol,
                    entryBinPrice: activeBin.price,
                    entryPriceUsd: entryPriceUsd,
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
