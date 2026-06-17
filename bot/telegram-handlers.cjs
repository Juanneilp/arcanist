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
        let currentActivePositions = readState();
        
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
                        const rangeStatus = details.inRange ? "✅ In Range" : "⚠️ OOR";
                        const closeModeIcon = (pos.closeMode || 'auto') === 'auto' ? '🤖 Auto' : '👤 Manual';
                        
                        if (pnlCurrency === 'SOL' && solPriceUsd > 0) {
                            const pnlSol = Math.abs(details.pnlUsd) / solPriceUsd;
                            msg += `   ${pnlColor} PnL: ${pnlSign}${pnlSol.toFixed(4)} SOL (${pnlSign}${Math.abs(details.pnlPct).toFixed(2)}%)\n`;
                        } else {
                            msg += `   ${pnlColor} PnL: ${pnlSign}${Math.abs(details.pnlUsd).toFixed(2)} (${pnlSign}${Math.abs(details.pnlPct).toFixed(2)}%)\n`;
                        }
                        msg += `   💎 Fees: $${details.unclaimedFeesUsd.toFixed(4)} | 💰 Value: $${details.totalValueUsd.toFixed(4)}\n`;
                        msg += `   ⏱ Age: ${formatAge(ageMinutes)} | ⚙️ ${closeModeIcon}\n`;
                        msg += `   ${rangeStatus}\n`;
                        if (pos.entryReason) {
                            const safeReason = pos.entryReason.replace(/[_*`\[\]]/g, '');
                            msg += `   💡 Reason: _${safeReason}_\n`;
                        }
                    } else {
                        const closeModeIcon = (pos.closeMode || 'auto') === 'auto' ? '🤖 Auto' : '👤 Manual';
                        msg += `   Invested: ${investedStr} SOL\n`;
                        msg += `   ⏱ Age: ${formatAge(ageMinutes)} | ⚙️ ${closeModeIcon}\n`;
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
                        const rangeStatus = details.inRange ? "✅ In Range" : "⚠️ OOR";
                        const closeModeIcon = (pos.closeMode || 'auto') === 'auto' ? '🤖 Auto' : '👤 Manual';
                        
                        if (pnlCurrency === 'SOL' && solPriceUsd > 0) {
                            const pnlSol = Math.abs(details.pnlUsd) / solPriceUsd;
                            msg += `   ${pnlColor} PnL: ${pnlSign}${pnlSol.toFixed(4)} SOL (${pnlSign}${Math.abs(details.pnlPct).toFixed(2)}%)\n`;
                        } else {
                            msg += `   ${pnlColor} PnL: ${pnlSign}${Math.abs(details.pnlUsd).toFixed(2)} (${pnlSign}${Math.abs(details.pnlPct).toFixed(2)}%)\n`;
                        }
                        msg += `   💎 Fees: $${details.unclaimedFeesUsd.toFixed(4)} | 💰 Value: $${details.totalValueUsd.toFixed(4)}\n`;
                        msg += `   ⏱ Age: ${formatAge(ageMinutes)} | ⚙️ ${closeModeIcon}\n`;
                        msg += `   ${rangeStatus}\n`;
                        if (pos.entryReason) {
                            const safeReason = pos.entryReason.replace(/[_*`\[\]]/g, '');
                            msg += `   💡 Reason: _${safeReason}_\n`;
                        }
                    } else {
                        const closeModeIcon = (pos.closeMode || 'auto') === 'auto' ? '🤖 Auto' : '👤 Manual';
                        msg += `   Invested: ${investedStr} SOL\n`;
                        msg += `   ⏱ Age: ${formatAge(ageMinutes)} | ⚙️ ${closeModeIcon}\n`;
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
    const strategyType = config.meteoraConfig?.strategyType ?? 0;
    
    ctx.reply(`⏳ Checking wallet balance and pools for ${tokenMint}...`);
    try {
        const solCtx = setupSolanaContext();
        if (!solCtx) return ctx.reply("❌ Wallet not configured.");
        
        const solBalanceLamports = await solCtx.connection.getBalance(solCtx.walletKeypair.publicKey);
        const solBalance = solBalanceLamports / 1e9;
        
        if (solBalance < minSolToOpen) {
            return ctx.reply(`❌ **Insufficient Balance**\nYour wallet balance is ${solBalance.toFixed(4)} SOL.\nMinimum required to open position (minSolToOpen) is ${minSolToOpen} SOL.`, { parse_mode: 'Markdown' });
        }

        const gasReserve = config.meteoraConfig?.gasReserve || 0.1;
        const refundableReserve = config.meteoraConfig?.refundableReserve || 0.05;
        const availableBalance = Math.max(0, solBalance - gasReserve - refundableReserve);
        const solToDeploy = Math.min(investAmountSol, availableBalance);

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
        
        const bestPool = pools[0];
        let poolInfo = `✅ *Pool Found!*\n`;
        poolInfo += `• *Name*: ${bestPool.name || 'Unknown'}\n`;
        poolInfo += `• *Address*: \`${bestPool.poolAddress}\`\n`;
        if (bestPool.bin_step) poolInfo += `• *Bin Step*: ${bestPool.bin_step}\n`;
        if (bestPool.liquidity) poolInfo += `• *Liquidity*: $${Number(bestPool.liquidity).toFixed(2)}\n`;
        poolInfo += `\n⏳ Executing \`addLiquidity\` (${solToDeploy.toFixed(4)} SOL) in ${botMode.toUpperCase()} mode...`;
        ctx.reply(poolInfo, { parse_mode: 'Markdown' });
        
        const solLamports = Math.floor(solToDeploy * 1e9);
        const solMint = 'So11111111111111111111111111111111111111112';

        const positionPubKeyStr = await addLiquidity(
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
        
        if (positionPubKeyStr) {
            const posPubKey = typeof positionPubKeyStr === 'string' ? positionPubKeyStr : (positionPubKeyStr.positionPubKey || positionPubKeyStr.status || "Unknown");
            const tokenSymbol = bestPool.symbol_x && bestPool.symbol_y ? `${bestPool.symbol_x}-${bestPool.symbol_y}` : "MANUAL_ENTRY";
            addPosition({
                tokenMint: tokenMint,
                tokenSymbol: tokenSymbol,
                poolAddress: bestPool.poolAddress,
                positionPubKey: posPubKey,
                investedSol: solToDeploy,
                openedBy: 'manual',
                entryReason: "Manual open from Telegram",
                closeMode: "auto"
            });
            
            logTrade('ENTRY', {
                tokenMint,
                tokenSymbol: tokenSymbol,
                poolAddress: bestPool.poolAddress,
                positionPubKey: posPubKey,
                investedSol: solToDeploy,
                entryReason: "Manual open from Telegram"
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
        
        const currentActivePositions = readState();
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
        logTrade('EXIT', { ...pos, reason: "Manual close from Telegram", pnlUsd: finalPnlUsd, pnlPct: finalPnlPct, pnlSol: finalPnlSol });
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
        
        const positions = readState();
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
        
        const positions = readState();
        if (positions.length === 0) return ctx.reply("❌ No active positions to close.");
        
        const solCtx = setupSolanaContext();
        if (!solCtx) return ctx.reply("❌ Wallet not configured.");
        
        const configPath = path.join(__dirname, '..', 'user-config.json');
        let botMode = 'live';
        if (fs.existsSync(configPath)) {
            botMode = JSON.parse(fs.readFileSync(configPath, 'utf-8')).botMode || 'live';
        }
        
        ctx.reply(`⏳ Closing ${positions.length} positions in ${botMode.toUpperCase()} mode...`);
        
        for (let i = 0; i < positions.length; i++) {
            const pos = positions[i];
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
                logTrade('EXIT', { ...pos, reason: "Manual close_all from Telegram", pnlUsd: finalPnlUsd, pnlPct: finalPnlPct, pnlSol: finalPnlSol });
                
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
            msg += `${idx + 1}. ${emoji} *${actionText}* - ${safeSymbol}\n`;
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
        const currentActivePositions = readState();
        
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
        const text = ctx.message.text.trim();
        const parts = text.split(/\s+/);
        if (parts.length < 2) {
            return ctx.reply("❌ Invalid format. Use: /blacklist <token_address>");
        }
        
        const address = parts[1];
        
        const blacklistPath = path.join(__dirname, '..', 'blacklist.json');
        let blacklist = [];
        if (fs.existsSync(blacklistPath)) {
            blacklist = JSON.parse(fs.readFileSync(blacklistPath, 'utf-8'));
        }
        
        if (!blacklist.includes(address)) {
            blacklist.push(address);
            fs.writeFileSync(blacklistPath, JSON.stringify(blacklist, null, 2));
            ctx.reply(`✅ Token \`${address}\` added to blacklist.`, { parse_mode: 'Markdown' });
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
        
        const index = blacklist.indexOf(address);
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
    chatCommand,
    currencyCommand
};
