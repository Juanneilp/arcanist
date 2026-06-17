const fs = require('fs');
const path = require('path');
const { PublicKey, Connection, Keypair } = require('@solana/web3.js');
const util = require('util');
const { spawn } = require('child_process');
const { spawnAsync } = require('./api-utils.cjs');

const { calculateRSI, calculateMACD, calculateBollingerBands } = require('./indicators.cjs');
const { readState, removePosition, logTrade, updatePosition } = require('./state.cjs');
const { removeLiquidity, swapTokenToSol } = require('./solana-dex.cjs');
const { sendMessage } = require('./telegram.cjs');

async function getTokenBalance(connection, walletPubKey, tokenMintStr) {
    try {
        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(walletPubKey, {
            mint: new PublicKey(tokenMintStr)
        });
        if (tokenAccounts.value.length > 0) {
            const tokenAmount = tokenAccounts.value[0].account.data.parsed.info.tokenAmount;
            return { uiAmount: tokenAmount.uiAmount, rawAmount: tokenAmount.amount };
        }
    } catch (e) {
        console.error("Error fetching token balance:", e);
    }
    return { uiAmount: 0, rawAmount: "0" };
}

async function evaluateExitCondition(position) {
    const configPath = path.join(__dirname, '..', 'user-config.json');
    let userConfig;
    try {
        userConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (e) {
        return { shouldExit: false };
    }
    
    const exitConf = userConfig.exitConfig || {};
    const tpPercentage = exitConf.tpPercentage !== undefined ? exitConf.tpPercentage : 50;
    const slPercentage = exitConf.slPercentage !== undefined ? exitConf.slPercentage : 20;
    const maxHoldHours = exitConf.maxHoldHours !== undefined ? exitConf.maxHoldHours : 24;
    const minHoldMinutes = exitConf.minHoldMinutes !== undefined ? exitConf.minHoldMinutes : 15;
    const rsiConf = exitConf.rsi || { period: 2, upperLimit: 90 };
    const bbConf = exitConf.bb || { period: 20, multiplier: 2 };
    const macdConf = exitConf.macd || { fast: 12, slow: 26, signal: 9 };
    
    const apiKey = process.env.GMGN_API_KEY || 'gmgn_solbscbaseethmonadtron';
    const chain = userConfig.apiSettings?.chain || 'sol';
    const fromTimestamp = Math.floor(Date.now() / 1000) - (48 * 60 * 60);
    
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(position.tokenMint) && !/^0x[a-fA-F0-9]{40}$/.test(position.tokenMint)) {
        console.error(`[Security] Invalid address format detected: ${position.tokenMint}`);
        return { shouldExit: false };
    }
    
    try {
        const durationHours = (Date.now() - position.timestamp) / 3600000;
        if (maxHoldHours > 0 && durationHours >= maxHoldHours) {
            console.log(`[EXIT SIGNAL] ${position.tokenSymbol}: Timeout hit (${durationHours.toFixed(2)}h >= ${maxHoldHours}h)`);
            return { shouldExit: true, reason: `Timeout hit (${durationHours.toFixed(2)}h >= ${maxHoldHours}h)` };
        }

        const isOOR = position.activeBinId !== undefined && position.minBinId !== undefined && position.maxBinId !== undefined &&
                      (position.activeBinId < position.minBinId || position.activeBinId > position.maxBinId);

        if (isOOR) {
            let binsOOR = 0;
            if (position.activeBinId < position.minBinId) binsOOR = position.minBinId - position.activeBinId;
            else if (position.activeBinId > position.maxBinId) binsOOR = position.activeBinId - position.maxBinId;
            
            console.log(`[OOR] ${position.tokenSymbol} is currently OOR by ${binsOOR} bins.`);
            
            const maxOorDistance = exitConf.maxOorDistance !== undefined ? exitConf.maxOorDistance : 10;
            if (binsOOR > maxOorDistance) {
                console.log(`[EXIT SIGNAL] ${position.tokenSymbol}: OOR Distance (${binsOOR} bins) > ${maxOorDistance} bins`);
                return { shouldExit: true, reason: `OOR Distance (${binsOOR} bins) > ${maxOorDistance} bins` };
            }
            
            if (position.oorTimestamp) {
                const maxOorMinutes = exitConf.maxOorMinutes !== undefined ? exitConf.maxOorMinutes : 15;
                const oorDurationMinutes = (Date.now() - position.oorTimestamp) / 60000;
                if (oorDurationMinutes >= maxOorMinutes) {
                    console.log(`[EXIT SIGNAL] ${position.tokenSymbol}: OOR Timeout (${oorDurationMinutes.toFixed(1)}m >= ${maxOorMinutes}m)`);
                    return { shouldExit: true, reason: `OOR Timeout (${oorDurationMinutes.toFixed(1)}m >= ${maxOorMinutes}m)` };
                }
            }
            
            return { shouldExit: false };
        }

        const { stdout } = await spawnAsync('npx', [
            'gmgn-cli', 'market', 'kline', 
            '--chain', chain, 
            '--address', position.tokenMint, 
            '--resolution', '15m', 
            '--from', fromTimestamp.toString(), 
            '--raw'
        ], {
            env: { ...process.env, GMGN_API_KEY: apiKey }
        });
        const response = JSON.parse(stdout);
        
        let currentClose = null;
        if (response.list && response.list.length > 0) {
            const tempSortedKlines = [...response.list].sort((a, b) => a.time - b.time);
            currentClose = parseFloat(tempSortedKlines[tempSortedKlines.length - 1].close);
        }

        if (position.entryPriceUsd && currentClose !== null) {
            const pnlPercentage = ((currentClose - position.entryPriceUsd) / position.entryPriceUsd) * 100;
            if (tpPercentage > 0 && pnlPercentage >= tpPercentage) {
                console.log(`[EXIT SIGNAL] ${position.tokenSymbol}: Take Profit hit (+${pnlPercentage.toFixed(2)}% >= ${tpPercentage}%)`);
                return { shouldExit: true, reason: `Take Profit hit (+${pnlPercentage.toFixed(2)}% >= ${tpPercentage}%)` };
            }
            if (slPercentage > 0 && pnlPercentage <= -slPercentage) {
                console.log(`[EXIT SIGNAL] ${position.tokenSymbol}: Stop Loss hit (${pnlPercentage.toFixed(2)}% <= -${slPercentage}%)`);
                return { shouldExit: true, reason: `Stop Loss hit (${pnlPercentage.toFixed(2)}% <= -${slPercentage}%)` };
            }
        }
        
        const durationMinutes = (Date.now() - position.timestamp) / 60000;
        if (durationMinutes < minHoldMinutes) {
            return { shouldExit: false };
        }
        
        if (!response.list || response.list.length < Math.max(rsiConf.period, bbConf.period, macdConf.slow) + 10) {
            console.log(`Not enough kline data to evaluate technical indicators for ${position.tokenSymbol}.`);
            return { shouldExit: false };
        }
        
        const sortedKlines = response.list.sort((a, b) => a.time - b.time);
        const closes = sortedKlines.map(k => parseFloat(k.close));
        
        const rsiArr = calculateRSI(closes, rsiConf.period);
        const bb = calculateBollingerBands(closes, bbConf.period, bbConf.multiplier);
        const macd = calculateMACD(closes, macdConf.fast, macdConf.slow, macdConf.signal);
        
        const lastIdx = closes.length - 1;
        const closedIdx = lastIdx - 1;
        
        const indicatorClose = closes[closedIdx];
        const currentRsi = rsiArr[closedIdx];
        const currentBbUpper = bb.upper[closedIdx];
        const currentMacdHist = macd.histogram[closedIdx];
        const prevMacdHist = macd.histogram[closedIdx - 1];
        
        if (currentRsi === null || currentBbUpper === null || currentMacdHist === null || prevMacdHist === null) {
            return { shouldExit: false };
        }

        const rsiConditionMet = currentRsi > rsiConf.upperLimit;
        const priceAboveBbUpper = indicatorClose > currentBbUpper;
        const macdFirstGreenHist = prevMacdHist <= 0 && currentMacdHist > 0;
        
        if (rsiConditionMet && priceAboveBbUpper) {
            console.log(`[EXIT SIGNAL] ${position.tokenSymbol}: [IN RANGE] RSI(${rsiConf.period})=${currentRsi.toFixed(2)} > ${rsiConf.upperLimit} AND Close > BB Upper`);
            return { shouldExit: true, reason: `RSI(${rsiConf.period})=${currentRsi.toFixed(2)} > ${rsiConf.upperLimit} dan Harga > BB Upper` };
        }
        
        if (rsiConditionMet && macdFirstGreenHist) {
            console.log(`[EXIT SIGNAL] ${position.tokenSymbol}: [IN RANGE] RSI(${rsiConf.period})=${currentRsi.toFixed(2)} > ${rsiConf.upperLimit} AND MACD First Green Histogram`);
            return { shouldExit: true, reason: `RSI(${rsiConf.period})=${currentRsi.toFixed(2)} > ${rsiConf.upperLimit} dan trigger MACD positif` };
        }
        
    } catch (e) {
        console.error(`Error checking exit conditions for ${position.tokenSymbol}:`, e.message);
    }
    
    return { shouldExit: false };
}

const dlmmPoolCache = {};

async function monitoringLoop(connection, walletKeypair) {
    const configPath = path.join(__dirname, '..', 'user-config.json');
    let userConfig;
    try {
        userConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (e) {
        return;
    }
    
    const botMode = userConfig.botMode || "dry_run";
    const activePositions = readState();
    if (activePositions.length === 0) return;
    
    console.log(`[Monitor] Checking ${activePositions.length} active positions...`);
    
    let DLMM;
    try {
        DLMM = require('@meteora-ag/dlmm').default || require('@meteora-ag/dlmm');
    } catch(e) {}
    
    for (let pos of activePositions) {
        const posCloseMode = pos.closeMode || "auto";
        if (posCloseMode === "manual") continue;
        
        try {
            const posAccountInfo = await connection.getAccountInfo(new PublicKey(pos.positionPubKey));
            if (!posAccountInfo || posAccountInfo.owner.toBase58() === "11111111111111111111111111111111") {
                console.log(`[Monitor] Position ${pos.positionPubKey} not found or already closed on-chain. Removing from state.`);
                removePosition(pos.positionPubKey);
                continue;
            }
        } catch (e) {
            console.error(`[Monitor] Failed to verify position account ${pos.positionPubKey}:`, e.message);
        }
        
        if (DLMM) {
            if (!dlmmPoolCache[pos.poolAddress]) {
                try {
                    dlmmPoolCache[pos.poolAddress] = await DLMM.create(connection, new PublicKey(pos.poolAddress), { cluster: "mainnet-beta" });
                } catch(e) {
                    console.error(`[Monitor] Failed to create DLMM for ${pos.poolAddress}:`, e.message);
                }
            }
            
            const dlmmPool = dlmmPoolCache[pos.poolAddress];
            
            if (dlmmPool) {
                try {
                    await dlmmPool.refetchStates();
                    const activeBin = await dlmmPool.getActiveBin();
                    pos.activeBinId = activeBin.binId;
                    
                    if (pos.minBinId === undefined || pos.maxBinId === undefined) {
                        const posAccount = await dlmmPool.program.account.positionV2.fetch(new PublicKey(pos.positionPubKey));
                        pos.minBinId = posAccount.lowerBinId;
                        pos.maxBinId = posAccount.upperBinId;
                        updatePosition(pos.positionPubKey, { minBinId: pos.minBinId, maxBinId: pos.maxBinId });
                    }
                    
                    if (pos.activeBinId !== undefined && pos.minBinId !== undefined && pos.maxBinId !== undefined) {
                        const isOOR = pos.activeBinId < pos.minBinId || pos.activeBinId > pos.maxBinId;
                        if (isOOR && !pos.oorTimestamp) {
                            pos.oorTimestamp = Date.now();
                            updatePosition(pos.positionPubKey, { oorTimestamp: pos.oorTimestamp });
                        } else if (!isOOR && pos.oorTimestamp) {
                            pos.oorTimestamp = null;
                            updatePosition(pos.positionPubKey, { oorTimestamp: null });
                        }
                    }
                } catch(e) {
                    console.error(`[Monitor] Error reading fresh states for ${pos.poolAddress}:`, e.message);
                }
            }
        }
        
        const exitData = await evaluateExitCondition(pos);
        if (exitData.shouldExit) {
            let finalPnlUsd = undefined;
            let finalPnlPct = undefined;
            let finalPnlSol = undefined;
            let pnlMessageStr = "";
            
            try {
                const { fetchMeteoraPositionDetails } = require('./solana-dex.cjs');
                const detailsMap = await fetchMeteoraPositionDetails(walletKeypair.publicKey.toBase58());
                if (detailsMap && detailsMap[pos.positionPubKey]) {
                    finalPnlUsd = detailsMap[pos.positionPubKey].pnlUsd;
                    finalPnlPct = detailsMap[pos.positionPubKey].pnlPct;
                    
                    const { getSolPriceUsd } = require('./solana-dex.cjs');
                    const solPrice = await getSolPriceUsd();
                    if (solPrice > 0 && finalPnlUsd !== undefined) {
                        finalPnlSol = finalPnlUsd / solPrice;
                    }
                    
                    const pnlSign = finalPnlUsd >= 0 ? "+" : "-";
                    const configPath = path.join(__dirname, '..', 'user-config.json');
                    let pnlCurrency = 'USD';
                    try {
                        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
                        pnlCurrency = config.monitoringConfig?.pnlCurrency || 'USD';
                    } catch(e) {}
                    
                    if (pnlCurrency === 'SOL' && finalPnlSol !== undefined) {
                        pnlMessageStr = `\n💰 *Est PnL:* ${pnlSign}${Math.abs(finalPnlSol).toFixed(4)} SOL (${pnlSign}${Math.abs(finalPnlPct).toFixed(2)}%)`;
                    } else {
                        pnlMessageStr = `\n💰 *Est PnL:* ${pnlSign}$${Math.abs(finalPnlUsd).toFixed(2)} (${pnlSign}${Math.abs(finalPnlPct).toFixed(2)}%)`;
                    }
                }
            } catch(e) {
                console.error('Failed to fetch PnL before closing:', e.message);
            }

            console.log(`[Monitor] Exit condition met for position ${pos.positionPubKey}. Reason: ${exitData.reason}`);
            const timeStr = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) + ' WIB';
            const cleanTokenSymbol = pos.tokenSymbol ? pos.tokenSymbol.replace(/[_*`\[\]]/g, '') : 'Unknown';
            const cleanReason = exitData.reason ? exitData.reason.replace(/[_*`\[\]]/g, '') : 'Unknown';
            sendMessage(`🚨 *Closing Position* 🚨\nToken: ${cleanTokenSymbol}\nReason: _${cleanReason}_${pnlMessageStr}\n⏱ *Time:* ${timeStr}`);
            
            try {
                await removeLiquidity(connection, walletKeypair, pos.poolAddress, pos.positionPubKey, botMode);
                sendMessage(`✅ Liquidity Removed for ${cleanTokenSymbol}`);
                
                removePosition(pos.positionPubKey);
                
                // Jeda 3 detik agar RPC Solana memiliki waktu untuk update state balance (menghindari Dust Sweep false alarm)
                await new Promise(resolve => setTimeout(resolve, 3000));
                
                let reclaimedSol = 0;
                const balance = await getTokenBalance(connection, walletKeypair.publicKey, pos.tokenMint);
                if (balance.uiAmount > 0) {
                    sendMessage(`🧹 Dust Sweeping: Found ${balance.uiAmount} ${cleanTokenSymbol}`);
                    try {
                        const swapResult = await swapTokenToSol(connection, walletKeypair, pos.tokenMint, balance.rawAmount, botMode);
                        if (!swapResult.skipped) {
                            reclaimedSol = swapResult.expectedSolOut;
                            sendMessage(`✅ Swap Success! Reclaimed ~${swapResult.expectedSolOut.toFixed(4)} SOL`);
                        } else {
                            sendMessage(`ℹ️ Dust value too low (~$${swapResult.usdValue.toFixed(2)}). Skipped swap.`);
                        }
                    } catch (swapErr) {
                        console.error(`[Dust Sweep Error] Failed to swap ${cleanTokenSymbol}:`, swapErr.message);
                        sendMessage(`⚠️ Dust Sweep Failed for ${cleanTokenSymbol}: ${swapErr.message}\nToken may not be routable on Jupiter yet.`);
                    }
                }

                logTrade('EXIT', {
                    ...pos,
                    reason: exitData.reason,
                    reclaimedSol,
                    pnlUsd: finalPnlUsd,
                    pnlPct: finalPnlPct,
                    pnlSol: finalPnlSol
                });
            } catch (e) {
                const safeErrMsg = e.message.replace(/[_*`\[\]]/g, '');
                console.error(`Error closing position ${pos.positionPubKey}:`, e);
                sendMessage(`❌ *Error Closing Position* ${cleanTokenSymbol}: ${safeErrMsg}`);
            }
        }
    }
}

module.exports = {
    monitoringLoop,
    evaluateExitCondition,
    getTokenBalance
};
