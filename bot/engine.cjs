const fs = require('fs');
const path = require('path');
const { fetchMeteoraPools, addLiquidity } = require('./solana-dex.cjs');
const { readState, addPosition, logTrade } = require('./state.cjs');
const { screenCandidates } = require('./ai-agent.cjs');
const { sendMessage } = require('./telegram.cjs');
require('./envcrypt.cjs').loadEnv();

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

async function processCandidates(options = {}) {
    const {
        autoEntry = false,
        maxPositions = 2,
        botConfig = {},
        connection = null,
        walletKeypair = null,
        botMode = 'live',
        skipDeployment = false
    } = options;

    if (!autoEntry && !skipDeployment) {
        console.log("Auto Entry is disabled. Will run AI screening but skip Meteora deployment.");
    }

    const candidatesPath = path.join(__dirname, '..', 'candidates.json');
    if (!fs.existsSync(candidatesPath)) {
        console.log("No candidates.json found.");
        return;
    }

    let candidates = JSON.parse(fs.readFileSync(candidatesPath, 'utf-8'));
    console.log(`Loaded ${candidates.length} candidate(s) from JSON.`);
    
    const activePositions = readState();
    // De-duplicate by positionPubKey for accurate slot counting
    const uniquePositions = [...new Map(activePositions.map(p => [p.positionPubKey, p])).values()];
    const activeMints = uniquePositions.map(p => p.tokenMint);
    
    candidates.forEach(c => {
        c.is_active_position = activeMints.includes(c.address);
    });
    
    const availableSlots = autoEntry ? (maxPositions - uniquePositions.length) : maxPositions;
    const requestedAiLimit = Math.max(3, availableSlots + uniquePositions.length);
    
    if (candidates.length > 0) {
        sendMessage(`🔍 Found ${candidates.length} candidates. Requesting Hermes AI screening...`);
        // AI Screening
        candidates = await screenCandidates(candidates, requestedAiLimit);
        
        const top3 = candidates.slice(0, 3);
        let aiMsg = `🤖 *Hermes AI Selection (Top ${top3.length})* 🤖\n━━━━━━━━━━━━━━━━━━\n`;
        top3.forEach((t, index) => {
            const rankEmoji = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '💎';
            const cleanName = t.name ? t.name.replace(/[_*`\[\]]/g, '') : 'Unknown';
            const cleanSymbol = t.symbol ? t.symbol.replace(/[_*`\[\]]/g, '') : 'Unknown';
            const cleanReason = t.ai_reason ? t.ai_reason.replace(/[_*`\[\]]/g, '') : '';
            const activeFlag = t.is_active_position ? ' 🟢 *[ACTIVE]*' : '';
            
            aiMsg += `${rankEmoji} *${cleanName}* (${cleanSymbol})${activeFlag}\n`;
            aiMsg += `🔗 \`${t.address}\`\n`;
            aiMsg += `💰 *MCap:* $${(t.market_cap / 1000).toFixed(1)}k | 👥 *Holders:* ${t.holder_count}\n`;
            
            let statsStr = `📈 *Vol:* $${(t.volume / 1000).toFixed(1)}k | 🧠 *Degens:* ${t.smart_degen_count}`;
            if (t.latestSupertrend !== undefined) statsStr += `\n📊 *ST:* ${Number(t.latestSupertrend).toFixed(6)}`;
            if (t.volumeTrend !== undefined) statsStr += ` | 🌊 *Vol Trend:* ${t.volumeTrend} (${(t.volumeChangePercent || 0).toFixed(1)}%)`;
            aiMsg += `${statsStr}\n`;
            
            if (cleanReason) aiMsg += `💡 *Reason:* _${cleanReason}_\n`;
            aiMsg += `━━━━━━━━━━━━━━━━━━\n`;
        });
        sendMessage(aiMsg);
        
        if (!autoEntry || skipDeployment) {
            console.log("Skipping Meteora deployment loop (Auto Entry disabled or skipDeployment requested).");
            return candidates;
        }
        
        if (!connection || !walletKeypair) {
            console.error("Missing connection or walletKeypair for deployment.");
            return candidates;
        }

        let deployedCount = 0;
        for (const token of candidates) {
            if (deployedCount >= availableSlots) {
                console.log(`[Deploy] Reached available slots limit (${availableSlots}). Stopping deployment loop.`);
                break;
            }
            
            if (token.is_active_position) {
                console.log(`[Skip] ${token.symbol} is already an active position (prevent double deploy).`);
                continue;
            }
            console.log(`\n==================================================`);
            console.log(`Processing Token: ${token.symbol} (${token.address})`);
            
            let solToDeploy = 0;
            try {
                let walletBalanceUi = 0;
                if (botMode === 'dry_run' && (!process.env.WALLET_PRIVATE_KEY || process.env.WALLET_PRIVATE_KEY === 'your_wallet_private_key_base58')) {
                    walletBalanceUi = 5.0; 
                } else {
                    walletBalanceUi = (await connection.getBalance(walletKeypair.publicKey)) / 1e9;
                }

                const solPerPosition = botConfig.solPerPosition || 0.15;
                const minSolToOpen = botConfig.minSolToOpen || 0.21;
                const gasReserve = botConfig.gasReserve || 0.1;
                const refundableReserve = botConfig.refundableReserve || 0.05;

                if (walletBalanceUi < minSolToOpen) {
                    console.log(`[Skip] Wallet balance (${walletBalanceUi.toFixed(4)} SOL) is below minSolToOpen (${minSolToOpen} SOL).`);
                    continue;
                }

                const availableBalance = Math.max(0, walletBalanceUi - gasReserve - refundableReserve);
                solToDeploy = Math.min(availableBalance, solPerPosition);

                if (solToDeploy <= 0) {
                    console.log(`[Skip] Insufficient balance for deployment after gas and refundable reserves.`);
                    continue;
                }

                const allowedQuoteTokens = botConfig.allowedQuoteTokens || ['SOL'];
                const pools = await fetchMeteoraPools(token.address, allowedQuoteTokens);
        
                const minFeePercent = botConfig.minFeePercent;
                const maxFeePercent = botConfig.maxFeePercent;
                const filteredPools = pools.filter(p => {
                    const passBinStep = p.bin_step >= botConfig.minBinStep && p.bin_step <= botConfig.maxBinStep;
                    const passFee = (minFeePercent === undefined || p.base_fee_pct >= minFeePercent) &&
                                    (maxFeePercent === undefined || p.base_fee_pct <= maxFeePercent);
                    return passBinStep && passFee;
                });
                
                let finalPools = [];
                const allowOnlyYFees = botConfig.allowOnlyYFees !== undefined ? botConfig.allowOnlyYFees : true;
                
                if (!allowOnlyYFees && filteredPools.length > 0) {
                    const DLMM = require('@meteora-ag/dlmm');
                    const { PublicKey } = require('@solana/web3.js');
                    for (const p of filteredPools) {
                        try {
                            const poolAddressObj = new PublicKey(p.address);
                            const dlmmPool = await DLMM.create(connection, poolAddressObj);
                            const collectFeeMode = dlmmPool.lbPair.parameters.collectFeeMode;
                            // 1 = OnlyY (fees hanya di token Y / quote token)
                            if (collectFeeMode === 1) {
                                console.log(`[Skip] Pool ${p.address} filtered out because allowOnlyYFees is false and pool has OnlyY fees.`);
                                continue;
                            }
                        } catch (err) {
                            console.error(`Failed to fetch collectFeeMode for ${p.address}: ${err.message}`);
                        }
                        finalPools.push(p);
                    }
                } else {
                    finalPools = filteredPools;
                }
                
                if (finalPools.length === 0) {
                    console.warn(`No matching Meteora pool found for ${token.symbol}/SOL with bin steps between ${botConfig.minBinStep} and ${botConfig.maxBinStep} and fee filter.`);
                    continue;
                }
                
                const targetPool = finalPools.sort((a, b) => {
                    if (b.avg_fees_per_min !== a.avg_fees_per_min) {
                        return (b.avg_fees_per_min || 0) - (a.avg_fees_per_min || 0);
                    }
                    return (b.liquidity || 0) - (a.liquidity || 0);
                })[0];
                const solLamportsToLP = Math.floor(solToDeploy * 1e9);
                
                console.log(`[${botMode.toUpperCase()}] Adding Single-Sided SOL Liquidity to ${targetPool.address} (Bin Step: ${targetPool.bin_step})...`);
                const result = await addLiquidity(connection, walletKeypair, targetPool.address, WSOL_MINT, solLamportsToLP, botConfig.minRange, botConfig.maxRange, { type: botConfig.strategyType }, botMode);
                
                // Guard: Check if deploy was skipped
                if (result && result.status === "skipped") {
                    const cleanSymbol = token.symbol ? token.symbol.replace(/[_*`\[\]]/g, '') : 'Unknown';
                    if (result.reason === "insufficient_balance") {
                        console.log(`[Skip] ${token.symbol}: Deploy skipped - ${result.reason}. Needed: ${result.requiredSol} SOL`);
                        sendMessage(`⚠️ *Deploy Skipped: ${cleanSymbol}*\nReason: Insufficient balance for setup + liquidity.\nNeeded: ~${result.requiredSol?.toFixed(4)} SOL\nWallet: ${result.currentBalanceSol?.toFixed(4)} SOL\nPool: \`${targetPool.address}\``);
                    } else {
                        console.log(`[Skip] ${token.symbol}: Deploy skipped - ${result.reason}. Cost: ${result.cost} SOL`);
                        sendMessage(`⚠️ *Deploy Skipped: ${cleanSymbol}*\nReason: Non-refundable binArray cost detected!\nCost: ~${result.cost?.toFixed(4) || '?'} SOL (${result.binArrayCount || '?'} binArrays)\nPool: \`${targetPool.address}\``);
                    }
                    continue;
                }
                
                if (botMode === "dry_run") {
                    sendMessage(`ℹ️ *DRY RUN: Entry Skipped*\nToken: ${token.symbol}\nPool: \`${targetPool.address}\``);
                    continue;
                }
                
                let entryPriceUsd = null;
                try {
                    const { fetchWithRetry } = require('./api-utils.cjs');
                    const res = await fetchWithRetry(`https://api.jup.ag/price/v3?ids=${token.address}`);
                    if (res.ok) {
                        const data = await res.json();
                        if (data[token.address] && data[token.address].usdPrice) {
                            entryPriceUsd = parseFloat(data[token.address].usdPrice);
                        } else if (data.data && data.data[token.address]) {
                            entryPriceUsd = parseFloat(data.data[token.address].price || data.data[token.address].usdPrice);
                        }
                    }
                } catch (e) {
                    console.error(`Failed to fetch Jupiter price for ${token.symbol}:`, e.message);
                }
                
                const cleanTokenSymbol = token.symbol ? token.symbol.replace(/[_*`\[\]]/g, '') : 'Unknown';
                const cleanAiReason = token.ai_reason ? token.ai_reason.replace(/[_*`\[\]]/g, '') : "Memenuhi syarat fundamental & Supertrend hijau";
                
                const { fetchMetricsForEntry } = require('./gmgn-client.cjs');
                const metrics = await fetchMetricsForEntry(token.address);
                
                const newPos = {
                    positionPubKey: result.positionPubKey,
                    poolAddress: targetPool.address,
                    tokenMint: token.address,
                    tokenSymbol: cleanTokenSymbol,
                    openedBy: "auto",
                    investedSol: solToDeploy,
                    entryBinPrice: result.activeBinPrice,
                    entryPriceUsd: entryPriceUsd,
                    minBinId: result.minBinId,
                    maxBinId: result.maxBinId,
                    entryType: "auto",
                    entryReason: cleanAiReason,
                    closeMode: "auto",
                    metrics: metrics
                };
                
                addPosition(newPos);
                logTrade('ENTRY', newPos);
                deployedCount++;
                
                const timeStr = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) + ' WIB';
                sendMessage(`🟢 *Position Opened* 🟢\nToken: ${cleanTokenSymbol}\nPool: \`${targetPool.address}\`\nPosition: \`${result.positionPubKey}\`\n💡 *Reason:* _${newPos.entryReason}_\n⏱ *Time:* ${timeStr}`);
                
            } catch (e) {
                console.error(`Error processing ${token.symbol}:`, e.message);
            }
        }
    } else {
        console.log("No available slots for new positions or no candidates.");
    }
    
    return candidates;
}

module.exports = {
    processCandidates
};
