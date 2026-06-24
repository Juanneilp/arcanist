const path = require('path');
const fs = require('fs');
const { Markup } = require('telegraf');
const bs58 = require('bs58').default || require('bs58');
const { Keypair, Connection } = require('@solana/web3.js');

// Helper to setup solana connections
function setupSolanaContext() {
    if (!process.env.WALLET_PRIVATE_KEY || process.env.WALLET_PRIVATE_KEY === 'your_wallet_private_key_base58') return null;
    try {
        const decodedKey = bs58.decode(process.env.WALLET_PRIVATE_KEY);
        const walletKeypair = Keypair.fromSecretKey(decodedKey);
        const connection = new Connection(process.env.RPC_URL || 'https://api.mainnet-beta.solana.com', { commitment: 'confirmed' });
        return { walletKeypair, connection };
    } catch (e) {
        return null;
    }
}

async function safeReplyWithMarkdown(ctx, msg) {
    try {
        await ctx.replyWithMarkdown(msg);
    } catch (e) {
        console.warn(`[Telegram] Markdown parse error (${e.message}), falling back to plain text.`);
        await ctx.reply(msg);
    }
}

function getEntryTypeFlag(pos) {
    if (pos.entryType === "web") return "🌐 Web Meteora";
    if (pos.entryType === "telegram") return "💬 Telegram";
    if (pos.entryType === "auto") return "🤖 Arcanist AI";
    
    // Fallbacks
    if (pos.entryReason && pos.entryReason.includes("Telegram")) return "💬 Telegram";
    if (pos.openedBy === "auto") return "🤖 Arcanist AI";
    return "🌐 Web Meteora";
}

// Middleware: Auth Guard
const authGuard = async (ctx, next) => {
    const allowedIds = [process.env.TELEGRAM_CHAT_ID].filter(Boolean);
    const isAuthorized = allowedIds.includes(String(ctx.from?.id)) || allowedIds.includes(String(ctx.chat?.id));
    
    if (!isAuthorized) {
        console.warn(`[Security] Unauthorized access attempt from chat ID: ${ctx.chat?.id} / user ID: ${ctx.from?.id}`);
        return; // silent reject
    }
    return next();
};

async function sendPositionsCommand(ctx) {
    try {
        const { readState } = require('./state.cjs');
        const { fetchMeteoraPositionDetails } = require('./solana-dex.cjs');
        let rawPositions = readState();
        // De-duplicate by positionPubKey (prefer auto over manual)
        const posMap = new Map();
        rawPositions.forEach(p => {
            if (!posMap.has(p.positionPubKey) || p.openedBy === 'auto') {
                posMap.set(p.positionPubKey, p);
            }
        });
        let currentActivePositions = [...posMap.values()];
        
        let meteoraDetails = null;
        let walletAddress = null;
        let solBalance = 0;
        
        const solCtx = setupSolanaContext();
        if (solCtx) {
            walletAddress = solCtx.walletKeypair.publicKey.toBase58();
            solBalance = (await solCtx.connection.getBalance(solCtx.walletKeypair.publicKey)) / 1e9;
        }

        if (walletAddress) {
            try {
                meteoraDetails = await fetchMeteoraPositionDetails(walletAddress);
            } catch(e) {}
        }

        const currentConfigPath = path.join(__dirname, '..', 'user-config.json');
        let currentMaxPositions = 1;
        let pnlCurrency = 'USD';
        let solPriceUsd = 1;
        try {
            const currentConfig = JSON.parse(fs.readFileSync(currentConfigPath, 'utf-8'));
            currentMaxPositions = currentConfig.monitoringConfig?.maxActivePositions || 1;
            pnlCurrency = currentConfig.monitoringConfig?.pnlCurrency || 'USD';
        } catch(e) {}
        
        if (pnlCurrency === 'SOL') {
            solPriceUsd = await require('./solana-dex.cjs').getSolPriceUsd();
        }

        let msg = `📊 *Wallet & Open Positions*\n─────────────────\n`;
        msg += `💳 *Wallet Balance*: ${solBalance.toFixed(4)} SOL\n`;
        msg += `📈 *Active*: ${currentActivePositions.length}/${currentMaxPositions} Limit\n─────────────────\n\n`;

        if (currentActivePositions.length === 0) {
            msg += `No active positions.`;
            await safeReplyWithMarkdown(ctx, msg);
        } else {
            const aiPositions = currentActivePositions.filter(p => p.openedBy === "auto");
            const manualPositions = currentActivePositions.filter(p => p.openedBy === "manual");

            let index = 1;
            
            const formatAge = (mins) => {
                if (mins < 60) return `${mins}m`;
                const h = Math.floor(mins / 60);
                const m = mins % 60;
                return `${h}h ${m}m`;
            };
            
            if (aiPositions.length > 0) {
                msg += `*AI Positions*\n`;
                aiPositions.forEach(pos => {
                    const ageMinutes = pos.timestamp ? Math.floor((Date.now() - pos.timestamp) / 60000) : 0;
                    const details = (meteoraDetails && ageMinutes >= 1) ? meteoraDetails[pos.positionPubKey] : null;
                    const investedStr = typeof pos.investedSol === 'number' ? pos.investedSol.toFixed(4) : pos.investedSol;
                    
                    const safeSymbol = (pos.tokenSymbol || 'Unknown').replace(/[_*`\[\]]/g, '');
                    msg += `${index}. 🤖 *${safeSymbol}-SOL*\n`;
                    if (details) {
                        const pnlSign = details.pnlUsd >= 0 ? "+" : "-";
                        const pnlColor = details.pnlUsd >= 0 ? "🟢" : "🔴";
                        let rangeStatus = details.inRange ? "✅ In Range" : "⚠️ OOR";
                        if (!details.inRange) {
                            let oorStrParts = [];
                            if (pos.oorTimestamp) {
                                const oorMins = Math.floor((Date.now() - pos.oorTimestamp) / 60000);
                                oorStrParts.push(`${formatAge(oorMins)}`);
                            }
                            if (pos.activeBinId !== undefined && pos.minBinId !== undefined && pos.maxBinId !== undefined) {
                                let binsOOR = 0;
                                if (pos.activeBinId < pos.minBinId) binsOOR = pos.minBinId - pos.activeBinId;
                                else if (pos.activeBinId > pos.maxBinId) binsOOR = pos.activeBinId - pos.maxBinId;
                                if (binsOOR > 0) oorStrParts.push(`${binsOOR} bins`);
                            }
                            if (oorStrParts.length > 0) {
                                rangeStatus += ` (${oorStrParts.join(' | ')})`;
                            }
                        }
                        const closeModeIcon = (pos.closeMode || 'auto') === 'auto' ? '🤖 Auto' : '👤 Manual';
                        
                        if (pnlCurrency === 'SOL' && solPriceUsd > 0) {
                            const pnlSol = Math.abs(details.pnlUsd) / solPriceUsd;
                            msg += `   ${pnlColor} PnL: ${pnlSign}${pnlSol.toFixed(4)} SOL (${pnlSign}${Math.abs(details.pnlPct).toFixed(2)}%)\n`;
                        } else {
                            msg += `   ${pnlColor} PnL: ${pnlSign}${Math.abs(details.pnlUsd).toFixed(2)} (${pnlSign}${Math.abs(details.pnlPct).toFixed(2)}%)\n`;
                        }
                        msg += `   💎 Fees: $${details.unclaimedFeesUsd.toFixed(4)} | 💰 Value: $${details.totalValueUsd.toFixed(4)}\n`;
                        msg += `   ⏱ Age: ${formatAge(ageMinutes)} | ⚙️ ${closeModeIcon} | ${getEntryTypeFlag(pos)}\n`;
                        msg += `   ${rangeStatus}\n`;
                        if (pos.entryReason) {
                            const safeReason = pos.entryReason.replace(/[_*`\[\]]/g, '');
                            msg += `   💡 Reason: _${safeReason}_\n`;
                        }
                    } else {
                        const closeModeIcon = (pos.closeMode || 'auto') === 'auto' ? '🤖 Auto' : '👤 Manual';
                        msg += `   Invested: ${investedStr} SOL\n`;
                        msg += `   ⏱ Age: ${formatAge(ageMinutes)} | ⚙️ ${closeModeIcon} | ${getEntryTypeFlag(pos)}\n`;
                        if (pos.entryReason) {
                            const safeReason = pos.entryReason.replace(/[_*`\[\]]/g, '');
                            msg += `   💡 Reason: _${safeReason}_\n`;
                        }
                    }
                    msg += `\n`;
                    index++;
                });
            }
            
            if (manualPositions.length > 0) {
                msg += `*Manual Positions*\n`;
                manualPositions.forEach(pos => {
                    const ageMinutes = pos.timestamp ? Math.floor((Date.now() - pos.timestamp) / 60000) : 0;
                    const details = (meteoraDetails && ageMinutes >= 1) ? meteoraDetails[pos.positionPubKey] : null;
                    const investedStr = typeof pos.investedSol === 'number' ? pos.investedSol.toFixed(4) : pos.investedSol;
                    
                    const safeSymbol = (pos.tokenSymbol || 'Unknown').replace(/[_*`\[\]]/g, '');
                    msg += `${index}. 👤 *${safeSymbol}/SOL* 🔒\n`;
                    if (details) {
                        const pnlSign = details.pnlUsd >= 0 ? "+" : "-";
                        const pnlColor = details.pnlUsd >= 0 ? "🟢" : "🔴";
                        let rangeStatus = details.inRange ? "✅ In Range" : "⚠️ OOR";
                        if (!details.inRange) {
                            let oorStrParts = [];
                            if (pos.oorTimestamp) {
                                const oorMins = Math.floor((Date.now() - pos.oorTimestamp) / 60000);
                                oorStrParts.push(`${formatAge(oorMins)}`);
                            }
                            if (pos.activeBinId !== undefined && pos.minBinId !== undefined && pos.maxBinId !== undefined) {
                                let binsOOR = 0;
                                if (pos.activeBinId < pos.minBinId) binsOOR = pos.minBinId - pos.activeBinId;
                                else if (pos.activeBinId > pos.maxBinId) binsOOR = pos.activeBinId - pos.maxBinId;
                                if (binsOOR > 0) oorStrParts.push(`${binsOOR} bins`);
                            }
                            if (oorStrParts.length > 0) {
                                rangeStatus += ` (${oorStrParts.join(' | ')})`;
                            }
                        }
                        const closeModeIcon = (pos.closeMode || 'auto') === 'auto' ? '🤖 Auto' : '👤 Manual';
                        
                        if (pnlCurrency === 'SOL' && solPriceUsd > 0) {
                            const pnlSol = Math.abs(details.pnlUsd) / solPriceUsd;
                            msg += `   ${pnlColor} PnL: ${pnlSign}${pnlSol.toFixed(4)} SOL (${pnlSign}${Math.abs(details.pnlPct).toFixed(2)}%)\n`;
                        } else {
                            msg += `   ${pnlColor} PnL: ${pnlSign}${Math.abs(details.pnlUsd).toFixed(2)} (${pnlSign}${Math.abs(details.pnlPct).toFixed(2)}%)\n`;
                        }
                        msg += `   💎 Fees: $${details.unclaimedFeesUsd.toFixed(4)} | 💰 Value: $${details.totalValueUsd.toFixed(4)}\n`;
                        msg += `   ⏱ Age: ${formatAge(ageMinutes)} | ⚙️ ${closeModeIcon} | ${getEntryTypeFlag(pos)}\n`;
                        msg += `   ${rangeStatus}\n`;
                        if (pos.entryReason) {
                            const safeReason = pos.entryReason.replace(/[_*`\[\]]/g, '');
                            msg += `   💡 Reason: _${safeReason}_\n`;
                        }
                    } else {
                        const closeModeIcon = (pos.closeMode || 'auto') === 'auto' ? '🤖 Auto' : '👤 Manual';
                        msg += `   Invested: ${investedStr} SOL\n`;
                        msg += `   ⏱ Age: ${formatAge(ageMinutes)} | ⚙️ ${closeModeIcon} | ${getEntryTypeFlag(pos)}\n`;
                        if (pos.entryReason) {
                            const safeReason = pos.entryReason.replace(/[_*`\[\]]/g, '');
                            msg += `   💡 Reason: _${safeReason}_\n`;
                        }
                    }
                    msg += `\n`;
                    index++;
                });
            }
            
            msg += `────────────────`;
            await safeReplyWithMarkdown(ctx, msg);
        }
    } catch (e) {
        ctx.reply("❌ Failed to read positions: " + e.message);
    }
}

async function openCommand(ctx) {
    const text = ctx.message.text.trim();
    const parts = text.split(/\s+/);
    if (parts.length < 2) {
        return ctx.reply("❌ Invalid format. Use: /open <token_mint> [sol_amount]");
    }
    const tokenMint = parts[1];
    
    const configPath = path.join(__dirname, '..', 'user-config.json');
    let config = {};
    if (fs.existsSync(configPath)) {
        config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }
    
    const defaultAmount = config.meteoraConfig?.solPerPosition || 0.1;
    const investAmountSol = parts.length >= 3 ? parseFloat(parts[2]) : defaultAmount;
    const minSolToOpen = config.meteoraConfig?.minSolToOpen || 0.1;
    const botMode = config.botMode || 'live';
    const minRange = config.meteoraConfig?.minRange ?? -90;
    const maxRange = config.meteoraConfig?.maxRange ?? 1;
    const strategyType = config.meteoraConfig?.strategyType ?? "spot";
    
    ctx.reply(`⏳ Checking wallet balance and pools for ${tokenMint}...`);
    try {
        const solCtx = setupSolanaContext();
        if (!solCtx) return ctx.reply("❌ Wallet not configured.");
        
        const solBalanceLamports = await solCtx.connection.getBalance(solCtx.walletKeypair.publicKey);
        const solBalance = solBalanceLamports / 1e9;
        
        const gasReserve = config.meteoraConfig?.gasReserve || 0.1;
        const refundableReserve = config.meteoraConfig?.refundableReserve || 0.05;
        const isExplicitAmount = parts.length >= 3;
        
        let solToDeploy;
        
        if (isExplicitAmount) {
            const requiredBalance = investAmountSol + gasReserve + refundableReserve;
            if (solBalance < requiredBalance) {
                return ctx.reply(`❌ **Insufficient Balance**\nYou requested to invest ${investAmountSol} SOL.\nRequired balance including reserves: ~${requiredBalance.toFixed(4)} SOL.\nYour wallet balance is ${solBalance.toFixed(4)} SOL.`, { parse_mode: 'Markdown' });
            }
            solToDeploy = investAmountSol;
        } else {
            if (solBalance < minSolToOpen) {
                return ctx.reply(`❌ **Insufficient Balance**\nYour wallet balance is ${solBalance.toFixed(4)} SOL.\nMinimum required to open position (minSolToOpen) is ${minSolToOpen} SOL.`, { parse_mode: 'Markdown' });
            }
            const availableBalance = Math.max(0, solBalance - gasReserve - refundableReserve);
            solToDeploy = Math.min(investAmountSol, availableBalance);
        }

        if (solToDeploy <= 0) {
            return ctx.reply(`❌ **Insufficient Balance for Reserves**\nYour wallet balance is ${solBalance.toFixed(4)} SOL.\nAfter deducting gas (${gasReserve}) and refundable (${refundableReserve}) reserves, available balance is too low.`, { parse_mode: 'Markdown' });
        }

        const { fetchMeteoraPools, addLiquidity } = require('./solana-dex.cjs');
        const { addPosition, logTrade } = require('./state.cjs');
        
        const allowedQuoteTokens = config.meteoraConfig?.allowedQuoteTokens || ['SOL'];
        const pools = await fetchMeteoraPools(tokenMint, allowedQuoteTokens);
        if (!pools || pools.length === 0) {
            return ctx.reply(`❌ No active DLMM pools found for ${tokenMint}.`);
        }
        
        const minBinStep = config.meteoraConfig?.minBinStep || 0;
        const maxBinStep = config.meteoraConfig?.maxBinStep || 1000;
        const minFeePercent = config.meteoraConfig?.minFeePercent;
        const maxFeePercent = config.meteoraConfig?.maxFeePercent;
        
        const filteredPools = pools.filter(p => {
            const passBinStep = p.bin_step >= minBinStep && p.bin_step <= maxBinStep;
            const passFee = (minFeePercent === undefined || p.base_fee_pct >= minFeePercent) &&
                            (maxFeePercent === undefined || p.base_fee_pct <= maxFeePercent);
            return passBinStep && passFee;
        });
        
        if (filteredPools.length === 0) {
            return ctx.reply(`❌ No active DLMM pools found within limits (Bin: ${minBinStep}-${maxBinStep}, Fee%: ${minFeePercent ?? 'any'}-${maxFeePercent ?? 'any'}) for ${tokenMint}.`);
        }
        
        const bestPool = filteredPools.sort((a, b) => {
            if (b.avg_fees_per_min !== a.avg_fees_per_min) {
                return (b.avg_fees_per_min || 0) - (a.avg_fees_per_min || 0);
            }
            return (b.liquidity || 0) - (a.liquidity || 0);
        })[0];
        let poolInfo = `✅ *Pool Found!*\n`;
        poolInfo += `• *Name*: ${bestPool.name || 'Unknown'}\n`;
        poolInfo += `• *Address*: \`${bestPool.poolAddress}\`\n`;
        if (bestPool.bin_step) poolInfo += `• *Bin Step*: ${bestPool.bin_step}\n`;
        if (bestPool.liquidity) poolInfo += `• *Liquidity*: $${Number(bestPool.liquidity).toFixed(2)}\n`;
        poolInfo += `\n⏳ Executing \`addLiquidity\` (${solToDeploy.toFixed(4)} SOL) in ${botMode.toUpperCase()} mode...`;
        ctx.reply(poolInfo, { parse_mode: 'Markdown' });
        
        const solLamports = Math.floor(solToDeploy * 1e9);
        const solMint = 'So11111111111111111111111111111111111111112';

        const positionResult = await addLiquidity(
            solCtx.connection, 
            solCtx.walletKeypair, 
            bestPool.poolAddress, 
            solMint, 
            solLamports, 
            minRange, 
            maxRange, 
            { type: strategyType }, 
            botMode
        );
        
        // Guard: Check if deploy was skipped
        if (positionResult && positionResult.status === "skipped") {
            if (positionResult.reason === "insufficient_balance") {
                return ctx.reply(`⚠️ *Deploy Skipped!*\nReason: Insufficient balance for setup + liquidity.\nNeeded: ~${positionResult.requiredSol?.toFixed(4)} SOL\nWallet: ${positionResult.currentBalanceSol?.toFixed(4)} SOL\n\nKurangi jumlah deposit atau siapkan saldo lebih untuk menutupi biaya setup.`, { parse_mode: 'Markdown' });
            } else {
                return ctx.reply(`⚠️ *Deploy Skipped!*\nReason: Non-refundable binArray cost detected!\nCost: ~${positionResult.cost?.toFixed(4) || '?'} SOL (${positionResult.binArrayCount || '?'} binArrays)\n\nTunggu hingga bin range ini sudah diinisialisasi oleh LP lain, atau pilih range yang lebih sempit.`, { parse_mode: 'Markdown' });
            }
        }
        
        if (positionResult) {
            const posPubKey = typeof positionResult === 'string' ? positionResult : (positionResult.positionPubKey || positionResult.status || "Unknown");
            const tokenSymbol = bestPool.symbol_x && bestPool.symbol_y ? `${bestPool.symbol_x}-${bestPool.symbol_y}` : "MANUAL_ENTRY";
            
            const { fetchMetricsForEntry } = require('./gmgn-client.cjs');
            const metrics = await fetchMetricsForEntry(tokenMint);
            
            addPosition({
                tokenMint: tokenMint,
                tokenSymbol: tokenSymbol,
                poolAddress: bestPool.poolAddress,
                positionPubKey: posPubKey,
                investedSol: solToDeploy,
                openedBy: 'manual',
                entryType: 'telegram',
                entryReason: "Manual open from Telegram",
                closeMode: "auto",
                metrics: metrics
            });
            
            logTrade('ENTRY', {
                tokenMint,
                tokenSymbol: tokenSymbol,
                poolAddress: bestPool.poolAddress,
                positionPubKey: posPubKey,
                investedSol: solToDeploy,
                entryReason: "Manual open from Telegram",
                metrics: metrics
            });
            
            let successMsg = `🎉 *Position Opened!*\n`;
            successMsg += `• *Token*: ${tokenMint}\n`;
            successMsg += `• *Invested*: ${solToDeploy.toFixed(4)} SOL\n`;
            successMsg += `• *Strategy Type*: ${strategyType}\n`;
            successMsg += `• *Range*: ${minRange}% to ${maxRange}%\n`;
            successMsg += `• *Position Key*: \`${posPubKey}\``;
            await ctx.reply(successMsg, { parse_mode: 'Markdown' });
            
            await sendPositionsCommand(ctx);
        } else {
            ctx.reply(`❌ Failed to open position (no pubkey returned).`);
        }
    } catch (e) {
        ctx.reply(`❌ Error opening position: ${e.message}`);
    }
}

async function closeCommand(ctx) {
    const text = ctx.message.text.trim();
    const parts = text.split(/\s+/);
    if (parts.length < 2) {
        return ctx.reply("❌ Invalid format. Use: /close <nomor_posisi>");
    }
    const index = parseInt(parts[1], 10) - 1;
    
    try {
        const { readState, removePosition, logTrade } = require('./state.cjs');
        const { removeLiquidity } = require('./solana-dex.cjs');
        
        const rawPositions = readState();
        // De-duplicate by positionPubKey to match display order
        const dedup = new Map();
        rawPositions.forEach(p => {
            if (!dedup.has(p.positionPubKey) || p.openedBy === 'auto') {
                dedup.set(p.positionPubKey, p);
            }
        });
        const currentActivePositions = [...dedup.values()];
        const aiPositions = currentActivePositions.filter(p => p.openedBy === "auto");
        const manualPositions = currentActivePositions.filter(p => p.openedBy === "manual");
        const combined = [...aiPositions, ...manualPositions];
        
        if (index < 0 || index >= combined.length) {
            return ctx.reply(`❌ Position number ${index+1} not found. Use /positions to view list.`);
        }
        
        const pos = combined[index];
        const solCtx = setupSolanaContext();
        if (!solCtx) return ctx.reply("❌ Wallet not configured.");
        
        const configPath = path.join(__dirname, '..', 'user-config.json');
        let botMode = 'live';
        if (fs.existsSync(configPath)) {
            botMode = JSON.parse(fs.readFileSync(configPath, 'utf-8')).botMode || 'live';
        }
        
        ctx.reply(`⏳ Closing position ${pos.tokenSymbol} (\`${pos.positionPubKey}\`) in ${botMode.toUpperCase()} mode...`, { parse_mode: 'Markdown' });
        let finalPnlUsd, finalPnlPct, finalPnlSol;
        try {
            const { fetchMeteoraPositionDetails } = require('./solana-dex.cjs');
            const detailsMap = await fetchMeteoraPositionDetails(solCtx.walletKeypair.publicKey.toBase58());
            if (detailsMap && detailsMap[pos.positionPubKey]) {
                finalPnlUsd = detailsMap[pos.positionPubKey].pnlUsd;
                finalPnlPct = detailsMap[pos.positionPubKey].pnlPct;
                const { getSolPriceUsd } = require('./solana-dex.cjs');
                const solPrice = await getSolPriceUsd();
                if (solPrice > 0 && finalPnlUsd !== undefined) finalPnlSol = finalPnlUsd / solPrice;
            }
        } catch(e) {}
        
        const txid = await removeLiquidity(solCtx.connection, solCtx.walletKeypair, pos.poolAddress, pos.positionPubKey, botMode);
        
        removePosition(pos.positionPubKey);
        const { fetchMetricsForEntry } = require('./gmgn-client.cjs');
        const exitMetrics = await fetchMetricsForEntry(pos.tokenMint).catch(()=>({}));
        logTrade('EXIT', { ...pos, reason: "Manual close from Telegram", pnlUsd: finalPnlUsd, pnlPct: finalPnlPct, pnlSol: finalPnlSol, exitMetrics });
        const statusStr = typeof txid === 'string' ? txid : (txid && txid.status ? txid.status : 'success');
        
        let pnlMsg = "";
        if (finalPnlUsd !== undefined) {
            const pnlSign = finalPnlUsd >= 0 ? "+" : "-";
            const configPath = path.join(__dirname, '..', 'user-config.json');
            let pnlCurrency = 'USD';
            try {
                const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
                pnlCurrency = config.monitoringConfig?.pnlCurrency || 'USD';
            } catch(e) {}
            if (pnlCurrency === 'SOL' && finalPnlSol !== undefined) {
                pnlMsg = `\n💰 *Est PnL:* ${pnlSign}${Math.abs(finalPnlSol).toFixed(4)} SOL (${pnlSign}${Math.abs(finalPnlPct).toFixed(2)}%)`;
            } else {
                pnlMsg = `\n💰 *Est PnL:* ${pnlSign}$${Math.abs(finalPnlUsd).toFixed(2)} (${pnlSign}${Math.abs(finalPnlPct).toFixed(2)}%)`;
            }
        }
        
        ctx.reply(`✅ *Position Closed!*\nStatus/TxID: \`${statusStr}\`${pnlMsg}`, { parse_mode: 'Markdown' });
    } catch (e) {
        ctx.reply(`❌ Error closing position: ${e.message}`);
    }
}

async function closeAllCommand(ctx) {
    try {
        const { readState } = require('./state.cjs');
        
        const rawPositions = readState();
        // De-duplicate by positionPubKey for accurate count
        const seen = new Set();
        const positions = rawPositions.filter(p => {
            if (seen.has(p.positionPubKey)) return false;
            seen.add(p.positionPubKey);
            return true;
        });
        if (positions.length === 0) return ctx.reply("❌ No active positions to close.");
        
        const configPath = path.join(__dirname, '..', 'user-config.json');
        let botMode = 'live';
        if (fs.existsSync(configPath)) {
            botMode = JSON.parse(fs.readFileSync(configPath, 'utf-8')).botMode || 'live';
        }
        
        const msg = `⚠️ *KONFIRMASI CLOSE ALL*\n\n` +
                    `Apakah Anda yakin ingin menutup *semua* (${positions.length}) posisi aktif?\n` +
                    `Mode Bot: *${botMode.toUpperCase()}*`;

        await ctx.reply(msg, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                Markup.button.callback('⚠️ Ya, Tutup Semua', 'confirm_close_all'),
                Markup.button.callback('❌ Batal', 'cancel_close_all')
            ])
        });
    } catch (e) {
        ctx.reply(`❌ Error: ${e.message}`);
    }
}

async function confirmCloseAllAction(ctx) {
    try {
        await ctx.answerCbQuery();
    } catch (e) {}

    try {
        await ctx.editMessageText(`⏳ Memproses penutupan semua posisi...`);
    } catch (e) {}

    try {
        const { readState, removePosition, logTrade } = require('./state.cjs');
        const { removeLiquidity } = require('./solana-dex.cjs');
        
        const rawPositions = readState();
        if (rawPositions.length === 0) return ctx.reply("❌ No active positions to close.");
        
        // De-duplicate by positionPubKey to prevent closing same on-chain position twice
        const seenKeys = new Set();
        const positions = rawPositions.filter(p => {
            if (seenKeys.has(p.positionPubKey)) return false;
            seenKeys.add(p.positionPubKey);
            return true;
        });
        
        const solCtx = setupSolanaContext();
        if (!solCtx) return ctx.reply("❌ Wallet not configured.");
        
        const configPath = path.join(__dirname, '..', 'user-config.json');
        let botMode = 'live';
        if (fs.existsSync(configPath)) {
            botMode = JSON.parse(fs.readFileSync(configPath, 'utf-8')).botMode || 'live';
        }
        
        ctx.reply(`⏳ Closing ${positions.length} positions in ${botMode.toUpperCase()} mode...`);
        
        const closedPubKeys = new Set();
        for (let i = 0; i < positions.length; i++) {
            const pos = positions[i];
            if (closedPubKeys.has(pos.positionPubKey)) continue;
            ctx.reply(`⏳ Closing ${i+1}/${positions.length}: ${pos.tokenSymbol}...`);
            try {
                let finalPnlUsd, finalPnlPct, finalPnlSol;
                try {
                    const { fetchMeteoraPositionDetails } = require('./solana-dex.cjs');
                    const detailsMap = await fetchMeteoraPositionDetails(solCtx.walletKeypair.publicKey.toBase58());
                    if (detailsMap && detailsMap[pos.positionPubKey]) {
                        finalPnlUsd = detailsMap[pos.positionPubKey].pnlUsd;
                        finalPnlPct = detailsMap[pos.positionPubKey].pnlPct;
                        const { getSolPriceUsd } = require('./solana-dex.cjs');
                        const solPrice = await getSolPriceUsd();
                        if (solPrice > 0 && finalPnlUsd !== undefined) finalPnlSol = finalPnlUsd / solPrice;
                    }
                } catch(e) {}
                
                await removeLiquidity(solCtx.connection, solCtx.walletKeypair, pos.poolAddress, pos.positionPubKey, botMode);
                removePosition(pos.positionPubKey);
                closedPubKeys.add(pos.positionPubKey);
                const { fetchMetricsForEntry } = require('./gmgn-client.cjs');
                const exitMetrics = await fetchMetricsForEntry(pos.tokenMint).catch(()=>({}));
                logTrade('EXIT', { ...pos, reason: "Manual close_all from Telegram", pnlUsd: finalPnlUsd, pnlPct: finalPnlPct, pnlSol: finalPnlSol, exitMetrics });
                
                let pnlMsg = "";
                if (finalPnlUsd !== undefined) {
                    const pnlSign = finalPnlUsd >= 0 ? "+" : "-";
                    const configPath = path.join(__dirname, '..', 'user-config.json');
                    let pnlCurrency = 'USD';
                    try {
                        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
                        pnlCurrency = config.monitoringConfig?.pnlCurrency || 'USD';
                    } catch(e) {}
                    if (pnlCurrency === 'SOL' && finalPnlSol !== undefined) {
                        pnlMsg = ` - PnL: ${pnlSign}${Math.abs(finalPnlSol).toFixed(4)} SOL (${pnlSign}${Math.abs(finalPnlPct).toFixed(2)}%)`;
                    } else {
                        pnlMsg = ` - PnL: ${pnlSign}$${Math.abs(finalPnlUsd).toFixed(2)} (${pnlSign}${Math.abs(finalPnlPct).toFixed(2)}%)`;
                    }
                }
                ctx.reply(`✅ Closed ${pos.tokenSymbol}${pnlMsg}`);
            } catch(err) {
                ctx.reply(`❌ Failed to close ${pos.tokenSymbol}: ${err.message}`);
            }
        }
        ctx.reply(`✅ Finished /close_all operation.`);
    } catch (e) {
        ctx.reply(`❌ Error during close_all: ${e.message}`);
    }
}

async function cancelCloseAllAction(ctx) {
    try {
        await ctx.answerCbQuery();
    } catch (e) {}
    try {
        await ctx.editMessageText(`❌ Operasi /close_all dibatalkan.`);
    } catch (e) {}
}

async function historyCommand(ctx) {
    try {
        const historyPath = path.join(__dirname, '..', 'trade_history.json');
        const configPath = path.join(__dirname, '..', 'user-config.json');
        let pnlCurrency = 'USD';
        if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            pnlCurrency = config.monitoringConfig?.pnlCurrency || 'USD';
        }
        if (!fs.existsSync(historyPath)) {
            return ctx.reply("📜 No trade history found.");
        }
        const history = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
        if (history.length === 0) {
            return ctx.reply("📜 Trade history is empty.");
        }
        
        const recent = history.slice(-10).reverse();
        let msg = `📜 *Recent Trade History (Last ${recent.length})*\n─────────────────\n`;
        
        recent.forEach((trade, idx) => {
            const isEntry = trade.action === 'ENTRY';
            const emoji = isEntry ? '🟢' : '🔴';
            const actionText = isEntry ? 'ENTRY' : 'EXIT';
            const safeSymbol = (trade.tokenSymbol || 'Unknown').replace(/[_*`\[\]]/g, '');
            msg += `${idx + 1}. ${emoji} *${actionText}* - ${safeSymbol} | ${getEntryTypeFlag(trade)}\n`;
            if (trade.reason || trade.entryReason) {
                const safeReason = (trade.reason || trade.entryReason).replace(/[_*`\[\]]/g, '');
                msg += `   💡 Reason: _${safeReason}_\n`;
            }
            const date = new Date(trade.timestamp).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
            msg += `   ⏱ Time: ${date}\n`;
            if (!isEntry) {
                if (trade.reclaimedSol) msg += `   💰 Reclaimed Dust: ${trade.reclaimedSol.toFixed(4)} SOL\n`;
                if (trade.pnlUsd !== undefined && trade.pnlPct !== undefined) {
                    const pnlSign = trade.pnlUsd >= 0 ? "+" : "-";
                    const pnlColor = trade.pnlUsd >= 0 ? "🟢" : "🔴";
                    let pnlDisplay = `${Math.abs(trade.pnlUsd).toFixed(2)}`;
                    
                    if (pnlCurrency === 'SOL' && trade.pnlSol !== undefined) {
                        pnlDisplay = `${Math.abs(trade.pnlSol).toFixed(4)} SOL`;
                    }
                    msg += `   ${pnlColor} PnL: ${pnlSign}${pnlDisplay} (${pnlSign}${Math.abs(trade.pnlPct).toFixed(2)}%)\n`;
                }
            } else if (isEntry && trade.investedSol) {
                msg += `   💰 Invested: ${trade.investedSol.toFixed(4)} SOL\n`;
            }
            msg += `\n`;
        });
        
        await safeReplyWithMarkdown(ctx, msg);
    } catch (e) {
        ctx.reply("❌ Error reading history: " + e.message);
    }
}

async function toggleCloseCommand(ctx) {
    try {
        const text = ctx.message.text.trim();
        const parts = text.split(/\s+/);
        if (parts.length < 2) {
            return ctx.reply("❌ Invalid format. Use: /toggle_close <nomor_posisi>");
        }
        const index = parseInt(parts[1], 10) - 1;
        
        const { readState, updatePosition } = require('./state.cjs');
        const rawPositions = readState();
        // De-duplicate by positionPubKey to match display order
        const dedup = new Map();
        rawPositions.forEach(p => {
            if (!dedup.has(p.positionPubKey) || p.openedBy === 'auto') {
                dedup.set(p.positionPubKey, p);
            }
        });
        const currentActivePositions = [...dedup.values()];
        
        const aiPositions = currentActivePositions.filter(p => p.openedBy === "auto");
        const manualPositions = currentActivePositions.filter(p => p.openedBy === "manual");
        const combined = [...aiPositions, ...manualPositions];
        
        if (index < 0 || index >= combined.length) {
            return ctx.reply(`❌ Position number ${index+1} not found. Use /positions to view list.`);
        }
        
        const pos = combined[index];
        const currentMode = pos.closeMode || 'auto';
        const newMode = currentMode === 'auto' ? 'manual' : 'auto';
        
        updatePosition(pos.positionPubKey, { closeMode: newMode });
        
        ctx.reply(`✅ Close Mode for *${pos.tokenSymbol}* changed from *${currentMode}* to *${newMode}*.`, { parse_mode: 'Markdown' });
    } catch (e) {
        ctx.reply(`❌ Error toggling close mode: ${e.message}`);
    }
}

async function toggleAutoCommand(ctx) {
    try {
        const configPath = path.join(__dirname, '..', 'user-config.json');
        if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            if (!config.monitoringConfig) config.monitoringConfig = {};
            
            const currentEntry = config.monitoringConfig.entryMode || 'manual';
            const newMode = currentEntry === 'auto' ? 'manual' : 'auto';
            
            config.monitoringConfig.entryMode = newMode;
            config.monitoringConfig.closeMode = newMode;
            
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
            
            await safeReplyWithMarkdown(ctx, `⚙️ Bot Mode Changed!\nEntry Mode: *${newMode}*\nClose Mode: *${newMode}*`);
        } else {
            ctx.reply("❌ user-config.json not found.");
        }
    } catch (e) {
        ctx.reply("❌ Failed to toggle mode: " + e.message);
    }
}

async function scrapeCommand(ctx) {
    try {
        ctx.reply("⏳ Memulai proses screening/scraping secara manual...");
        const { runScraper } = require('./scraper.cjs');
        await runScraper();
        
        const { processCandidates } = require('./engine.cjs');
        await processCandidates({
            autoEntry: false,
            skipDeployment: true
        });
        
        ctx.reply("✅ Proses screening selesai. Anda bisa menggunakan /open untuk entry manual.");
    } catch (e) {
        ctx.reply("❌ Error saat scraping: " + e.message);
    }
}

async function getConfigCommand(ctx) {
    try {
        const text = ctx.message.text.trim();
        const parts = text.split(/\s+/);
        
        const configPath = path.join(__dirname, '..', 'user-config.json');
        if (!fs.existsSync(configPath)) {
            return ctx.reply("❌ user-config.json not found.");
        }
        
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        
        if (parts.length > 1) {
            const keyPath = parts[1];
            const keys = keyPath.split('.');
            let current = config;
            for (const k of keys) {
                if (current && typeof current === 'object' && k in current) {
                    current = current[k];
                } else {
                    return ctx.reply(`❌ Key \`${keyPath}\` not found in config.`, { parse_mode: 'Markdown' });
                }
            }
            await safeReplyWithMarkdown(ctx, `*Key*: \`${keyPath}\`\n*Value*: \`${JSON.stringify(current, null, 2)}\``);
        } else {
            const configStr = JSON.stringify(config, null, 2);
            if (configStr.length > 4000) {
                ctx.replyWithDocument({ source: configPath, filename: 'user-config.json' });
            } else {
                await safeReplyWithMarkdown(ctx, `\`\`\`json\n${configStr}\n\`\`\``);
            }
        }
    } catch (e) {
        ctx.reply("❌ Failed to get config: " + e.message);
    }
}

async function setConfigCommand(ctx) {
    try {
        const text = ctx.message.text.trim();
        const parts = text.split(/\s+/);
        if (parts.length < 3) {
            return ctx.reply("❌ Invalid format. Use: /setconfig <key> <value>\nExample: /setconfig localFilters.minMarketCap 300000");
        }
        
        const keyPath = parts[1];
        const valueStr = parts.slice(2).join(' ');
        
        let value;
        if (valueStr.toLowerCase() === 'true') value = true;
        else if (valueStr.toLowerCase() === 'false') value = false;
        else if (!isNaN(valueStr) && valueStr.trim() !== '') value = Number(valueStr);
        else {
            try {
                value = JSON.parse(valueStr);
            } catch(e) {
                value = valueStr;
            }
        }

        const configPath = path.join(__dirname, '..', 'user-config.json');
        if (!fs.existsSync(configPath)) {
            return ctx.reply("❌ user-config.json not found.");
        }
        
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        
        const keys = keyPath.split('.');
        let current = config;
        for (let i = 0; i < keys.length - 1; i++) {
            if (!(keys[i] in current) || typeof current[keys[i]] !== 'object') {
                current[keys[i]] = {};
            }
            current = current[keys[i]];
        }
        const lastKey = keys[keys.length - 1];
        const oldValue = current[lastKey];
        current[lastKey] = value;
        
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        
        let safeOldValue = oldValue === undefined ? "undefined" : JSON.stringify(oldValue);
        let safeNewValue = JSON.stringify(value);
        await safeReplyWithMarkdown(ctx, `✅ Config updated successfully!\n*Key*: \`${keyPath}\`\n*Old Value*: \`${safeOldValue}\`\n*New Value*: \`${safeNewValue}\``);
    } catch (e) {
        ctx.reply("❌ Failed to update config: " + e.message);
    }
}

async function blacklistCommand(ctx) {
    try {
        const text = ctx.message.text.replace(/^\/blacklist\s*/, '').trim();
        if (!text) {
            return ctx.reply("❌ Invalid format. Use: /blacklist <CA>, <Name>, <Reason>");
        }
        
        const parts = text.split(',').map(s => s.trim());
        const address = parts[0];
        const name = parts[1] || 'Unknown';
        const reason = parts.slice(2).join(', ') || 'No reason provided';
        
        const blacklistPath = path.join(__dirname, '..', 'blacklist.json');
        let blacklist = [];
        if (fs.existsSync(blacklistPath)) {
            blacklist = JSON.parse(fs.readFileSync(blacklistPath, 'utf-8'));
        }
        
        const exists = blacklist.some(b => (typeof b === 'string' ? b : b.address) === address);
        
        if (!exists) {
            blacklist.push({ address, name, reason });
            fs.writeFileSync(blacklistPath, JSON.stringify(blacklist, null, 2));
            ctx.reply(`✅ Token \`${address}\` added to blacklist.\n*Name*: ${name}\n*Reason*: ${reason}`, { parse_mode: 'Markdown' });
        } else {
            ctx.reply(`⚠️ Token \`${address}\` is already in blacklist.`, { parse_mode: 'Markdown' });
        }
    } catch (e) {
        ctx.reply("❌ Failed to add to blacklist: " + e.message);
    }
}

async function unblacklistCommand(ctx) {
    try {
        const text = ctx.message.text.trim();
        const parts = text.split(/\s+/);
        if (parts.length < 2) {
            return ctx.reply("❌ Invalid format. Use: /unblacklist <token_address>");
        }
        
        const address = parts[1];
        
        const blacklistPath = path.join(__dirname, '..', 'blacklist.json');
        let blacklist = [];
        if (fs.existsSync(blacklistPath)) {
            blacklist = JSON.parse(fs.readFileSync(blacklistPath, 'utf-8'));
        }
        
        const index = blacklist.findIndex(b => (typeof b === 'string' ? b : b.address) === address);
        if (index !== -1) {
            blacklist.splice(index, 1);
            fs.writeFileSync(blacklistPath, JSON.stringify(blacklist, null, 2));
            ctx.reply(`✅ Token \`${address}\` removed from blacklist.`, { parse_mode: 'Markdown' });
        } else {
            ctx.reply(`⚠️ Token \`${address}\` not found in blacklist.`, { parse_mode: 'Markdown' });
        }
    } catch (e) {
        ctx.reply("❌ Failed to remove from blacklist: " + e.message);
    }
}

async function viewBlacklistCommand(ctx) {
    try {
        const blacklistPath = path.join(__dirname, '..', 'blacklist.json');
        let blacklist = [];
        if (fs.existsSync(blacklistPath)) {
            blacklist = JSON.parse(fs.readFileSync(blacklistPath, 'utf-8'));
        }
        
        if (blacklist.length === 0) {
            return ctx.reply("📜 Blacklist is empty.");
        }
        
        let msg = `📜 *Blacklisted Tokens (${blacklist.length})*\n─────────────────\n`;
        blacklist.forEach((item, idx) => {
            const address = typeof item === 'string' ? item : item.address;
            const name = typeof item === 'string' ? 'Unknown' : (item.name || 'Unknown');
            const reason = typeof item === 'string' ? 'No reason provided' : (item.reason || 'No reason provided');
            msg += `${idx + 1}. *${name}*\n   🔗 \`${address}\`\n   💡 Reason: _${reason}_\n\n`;
        });
        
        if (msg.length > 4000) {
            return ctx.replyWithDocument({ source: blacklistPath, filename: 'blacklist.json' });
        }
        await safeReplyWithMarkdown(ctx, msg);
    } catch (e) {
        ctx.reply("❌ Failed to view blacklist: " + e.message);
    }
}

async function chatCommand(ctx) {
    const messageText = ctx.message.text.replace(/^\/chat\s*/, '').trim();
    if (!messageText) {
        return ctx.reply("Please provide a message. Example: /chat What is the best strategy today?");
    }
    
    console.log(`[Audit/Chat] User ${ctx.from?.id} (${ctx.from?.username || 'Unknown'}) asked: ${messageText.substring(0, 500)}`);
    
    ctx.reply("🤖 Thinking...");
    try {
        const { askAI } = require('./ai-agent.cjs');
        const aiResponse = await askAI(messageText);
        try {
            await ctx.replyWithMarkdown(aiResponse);
        } catch (mdError) {
            console.warn(`[Telegram] Failed to send AI response as Markdown, falling back to plain text. Reason: ${mdError.message}`);
            await ctx.reply(aiResponse);
        }
    } catch (e) {
        ctx.reply("❌ AI Error: " + e.message);
    }
}


async function currencyCommand(ctx) {
    try {
        const text = ctx.message.text.trim();
        const parts = text.split(/\s+/);
        
        const configPath = path.join(__dirname, '..', 'user-config.json');
        if (!fs.existsSync(configPath)) {
            return ctx.reply("❌ user-config.json not found.");
        }
        
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        if (!config.monitoringConfig) config.monitoringConfig = {};
        
        if (parts.length < 2) {
            const current = config.monitoringConfig.pnlCurrency || 'USD';
            return ctx.reply(`ℹ️ Current PnL calculation currency is: *${current}*\nUse /currency USD or /currency SOL to change it.`, { parse_mode: 'Markdown' });
        }
        
        const newCurrency = parts[1].toUpperCase();
        if (newCurrency !== 'USD' && newCurrency !== 'SOL') {
            return ctx.reply("❌ Invalid currency. Use USD or SOL.");
        }
        
        config.monitoringConfig.pnlCurrency = newCurrency;
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        
        await safeReplyWithMarkdown(ctx, `✅ PnL calculation currency changed to: *${newCurrency}*`);
    } catch (e) {
        ctx.reply("❌ Failed to set currency: " + e.message);
    }
}

// --- SETTINGS UI ---
const userSettingState = {};

function buildSettingsKeyboard(config) {
    const meteora = config.meteoraConfig || {};
    const monitor = config.monitoringConfig || {};
    const botMode = config.botMode || 'live';

    return Markup.inlineKeyboard([
        [Markup.button.callback(`Bot Mode: ${botMode.toUpperCase()}`, 'set_param_botMode')],
        [Markup.button.callback(`Entry Mode: ${(monitor.entryMode || 'auto').toUpperCase()}`, 'set_param_entryMode')],
        [Markup.button.callback(`Strategy Type: ${(meteora.strategyType || 'spot').toUpperCase()}`, 'set_param_strategyType')],
        [Markup.button.callback(`Sol/Pos: ${meteora.solPerPosition || 0.1}`, 'set_param_solPerPosition'), Markup.button.callback(`Max Pos: ${monitor.maxActivePositions || 1}`, 'set_param_maxActivePositions')],
        [Markup.button.callback(`Min Bin: ${meteora.minBinStep || 0}`, 'set_param_minBinStep'), Markup.button.callback(`Max Bin: ${meteora.maxBinStep || 100}`, 'set_param_maxBinStep')],
        [Markup.button.callback(`Min Fee: ${meteora.minFeePercent || 0}%`, 'set_param_minFeePercent'), Markup.button.callback(`Max Fee: ${meteora.maxFeePercent || 5}%`, 'set_param_maxFeePercent')],
        [Markup.button.callback(`Min Range: ${meteora.minRange || 0}`, 'set_param_minRange'), Markup.button.callback(`Max Range: ${meteora.maxRange || 1}`, 'set_param_maxRange')],
        [Markup.button.callback(`Only Y Fees: ${meteora.allowOnlyYFees !== false ? '✅ Yes' : '❌ No'}`, 'set_param_allowOnlyYFees')]
    ]);
}

async function settingsCommand(ctx) {
    try {
        const configPath = path.join(__dirname, '..', 'user-config.json');
        if (!fs.existsSync(configPath)) return ctx.reply("❌ user-config.json not found.");
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        
        await ctx.reply("⚙️ *Bot Settings*\nClick a button to toggle its value or enter a new value:", {
            parse_mode: 'Markdown',
            ...buildSettingsKeyboard(config)
        });
    } catch (e) {
        ctx.reply("❌ Error loading settings: " + e.message);
    }
}

async function settingsAction(ctx) {
    try {
        const paramName = ctx.match[1];
        const configPath = path.join(__dirname, '..', 'user-config.json');
        if (!fs.existsSync(configPath)) return ctx.answerCbQuery("❌ user-config.json not found", { show_alert: true });
        let config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        
        if (!config.meteoraConfig) config.meteoraConfig = {};
        if (!config.monitoringConfig) config.monitoringConfig = {};

        if (paramName === 'botMode') {
            config.botMode = config.botMode === 'live' ? 'dry_run' : 'live';
        } else if (paramName === 'entryMode') {
            config.monitoringConfig.entryMode = config.monitoringConfig.entryMode === 'auto' ? 'manual' : 'auto';
            config.monitoringConfig.closeMode = config.monitoringConfig.entryMode;
        } else if (paramName === 'allowOnlyYFees') {
            config.meteoraConfig.allowOnlyYFees = config.meteoraConfig.allowOnlyYFees === false ? true : false;
        } else if (paramName === 'strategyType') {
            const current = (config.meteoraConfig.strategyType || 'spot').toLowerCase();
            let next = 'spot';
            if (current === 'spot') next = 'curve';
            else if (current === 'curve') next = 'bid-ask';
            else if (current === 'bid-ask') next = 'mix';
            
            config.meteoraConfig.strategyType = next;
        } else {
            userSettingState[ctx.from.id] = paramName;
            await ctx.answerCbQuery();
            return ctx.reply(`✏️ Please type the new value for *${paramName}*:\n(Type /cancel to abort)`, { parse_mode: 'Markdown' });
        }

        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        try {
            await ctx.editMessageReplyMarkup(buildSettingsKeyboard(config).reply_markup);
        } catch(e) {}
        
        await ctx.answerCbQuery("✅ Settings updated!");
    } catch (e) {
        ctx.answerCbQuery("❌ Error: " + e.message, { show_alert: true });
    }
}

async function textHandler(ctx) {
    try {
        const userId = ctx.from?.id;
        if (!userId || !userSettingState[userId]) {
            return; // Not waiting for input
        }
        
        const paramName = userSettingState[userId];
        const textValue = ctx.message.text.trim();
        
        if (textValue.toLowerCase() === '/cancel') {
            delete userSettingState[userId];
            return ctx.reply("❌ Operation cancelled.");
        }
        
        const numericValue = Number(textValue);
        if (isNaN(numericValue)) {
            return ctx.reply("❌ Invalid format. Please enter a valid number, or type /cancel to cancel.");
        }
        
        const configPath = path.join(__dirname, '..', 'user-config.json');
        let config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        if (!config.meteoraConfig) config.meteoraConfig = {};
        if (!config.monitoringConfig) config.monitoringConfig = {};
        
        if (paramName === 'maxActivePositions') {
            config.monitoringConfig[paramName] = numericValue;
        } else {
            config.meteoraConfig[paramName] = numericValue;
        }
        
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        delete userSettingState[userId];
        
        await ctx.reply(`✅ *${paramName}* has been updated to \`${numericValue}\`.`, { parse_mode: 'Markdown' });
        await settingsCommand(ctx); // Show updated menu
    } catch (e) {
        ctx.reply("❌ Error saving setting: " + e.message);
    }
}

module.exports = {
    authGuard,
    sendPositionsCommand,
    openCommand,
    closeCommand,
    closeAllCommand,
    confirmCloseAllAction,
    cancelCloseAllAction,
    historyCommand,
    toggleCloseCommand,
    toggleAutoCommand,
    scrapeCommand,
    getConfigCommand,
    setConfigCommand,
    blacklistCommand,
    unblacklistCommand,
    viewBlacklistCommand,
    chatCommand,
    currencyCommand,
    settingsCommand,
    settingsAction,
    textHandler
};
