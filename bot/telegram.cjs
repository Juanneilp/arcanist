const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Telegraf, Markup } = require('telegraf');

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

let bot;
if (token && token !== 'your_telegram_bot_token') {
    bot = new Telegraf(token);
    
    bot.use((ctx, next) => {
        if (ctx.chat && ctx.chat.id.toString() === chatId) {
            return next();
        } else {
            console.warn(`[Security] Unauthorized access attempt from chat ID: ${ctx.chat?.id}`);
        }
    });

    // Command: /start or /help
    bot.help((ctx) => {
        const helpMsg = `🤖 Arcanist Bot Commands 🤖\n\n` +
                        `/positions - List active positions\n` +
                        `/history - View recent trade history\n` +
                        `/toggle_close <num> - Toggle close mode per posisi\n` +
                        `/toggle_auto - Toggle Global Auto Entry/Close Mode\n` +
                        `/scrape - Force run scraper & AI screening\n` +
                        `/chat [message] - Chat with Hermes AI Analyst`;
        ctx.reply(helpMsg);
    });
    bot.start((ctx) => ctx.reply("Welcome to Arcanist Bot! Type /help to see available commands."));

    // Command: /positions
    async function sendPositionsCommand(ctx) {
        try {
            const { readState, removePosition } = require('./state.cjs');
            const { fetchMeteoraPositionDetails } = require('./solana-dex.cjs');
            let currentActivePositions = readState();
            
            let meteoraDetails = null;
            let walletAddress = null;
            let solBalance = 0;
            
            if (process.env.WALLET_PRIVATE_KEY && process.env.WALLET_PRIVATE_KEY !== 'your_wallet_private_key_base58') {
                const bs58 = require('bs58').default || require('bs58');
                const { Keypair, Connection } = require('@solana/web3.js');
                try {
                    const decodedKey = bs58.decode(process.env.WALLET_PRIVATE_KEY);
                    const walletKeypair = Keypair.fromSecretKey(decodedKey);
                    walletAddress = walletKeypair.publicKey.toBase58();
                    
                    const connection = new Connection(process.env.RPC_URL || 'https://api.mainnet-beta.solana.com');
                    solBalance = (await connection.getBalance(walletKeypair.publicKey)) / 1e9;
                } catch(e) {}
            }

            if (walletAddress) {
                try {
                    meteoraDetails = await fetchMeteoraPositionDetails(walletAddress);
                } catch(e) {}
            }

            const currentConfigPath = path.join(__dirname, '..', 'user-config.json');
            let currentMaxPositions = 1;
            try {
                const currentConfig = JSON.parse(fs.readFileSync(currentConfigPath, 'utf-8'));
                currentMaxPositions = currentConfig.monitoringConfig?.maxActivePositions || 1;
            } catch(e) {}

            let msg = `📊 *Wallet & Open Positions*\n─────────────────\n`;
            msg += `💳 *Wallet Balance*: ${solBalance.toFixed(4)} SOL\n`;
            msg += `📈 *Active*: ${currentActivePositions.length}/${currentMaxPositions} Limit\n─────────────────\n\n`;

            if (currentActivePositions.length === 0) {
                msg += `No active positions.`;
                ctx.replyWithMarkdown(msg);
            } else {
                
                const aiPositions = currentActivePositions.filter(p => p.openedBy === "auto");
                const manualPositions = currentActivePositions.filter(p => p.openedBy === "manual");

                let index = 1;
                
                if (aiPositions.length > 0) {
                    msg += `*AI Positions*\n`;
                    aiPositions.forEach(pos => {
                        const ageMinutes = pos.timestamp ? Math.floor((Date.now() - pos.timestamp) / 60000) : 0;
                        const details = (meteoraDetails && ageMinutes >= 1) ? meteoraDetails[pos.positionPubKey] : null;
                        const investedStr = typeof pos.investedSol === 'number' ? pos.investedSol.toFixed(4) : pos.investedSol;
                        
                        msg += `${index}. 🤖 *${pos.tokenSymbol}-SOL*\n`;
                        if (details) {
                            const pnlSign = details.pnlUsd >= 0 ? "+" : "";
                            const pnlColor = details.pnlUsd >= 0 ? "🟢" : "🔴";
                            const rangeStatus = details.inRange ? "✅ In Range" : "⚠️ OOR";
                            const closeModeIcon = (pos.closeMode || 'auto') === 'auto' ? '🤖 Auto' : '👤 Manual';
                            
                            msg += `   ${pnlColor} PnL: ${pnlSign}$${Math.abs(details.pnlUsd).toFixed(2)} (${pnlSign}${details.pnlPct.toFixed(2)}%)\n`;
                            msg += `   💎 Fees: $${details.unclaimedFeesUsd.toFixed(4)} | 💰 Value: $${details.totalValueUsd.toFixed(4)}\n`;
                            msg += `   ⏱ Age: ${ageMinutes}m | ⚙️ ${closeModeIcon}\n`;
                            msg += `   ${rangeStatus}\n`;
                            if (pos.entryReason) msg += `   💡 Reason: _${pos.entryReason}_\n`;
                        } else {
                            const closeModeIcon = (pos.closeMode || 'auto') === 'auto' ? '🤖 Auto' : '👤 Manual';
                            msg += `   Invested: ${investedStr} SOL\n`;
                            msg += `   ⏱ Age: ${ageMinutes}m | ⚙️ ${closeModeIcon}\n`;
                            if (pos.entryReason) msg += `   💡 Reason: _${pos.entryReason}_\n`;
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
                        
                        msg += `${index}. 👤 *${pos.tokenSymbol}/SOL* 🔒\n`;
                        if (details) {
                            const pnlSign = details.pnlUsd >= 0 ? "+" : "";
                            const pnlColor = details.pnlUsd >= 0 ? "🟢" : "🔴";
                            const rangeStatus = details.inRange ? "✅ In Range" : "⚠️ OOR";
                            const closeModeIcon = (pos.closeMode || 'auto') === 'auto' ? '🤖 Auto' : '👤 Manual';
                            
                            msg += `   ${pnlColor} PnL: ${pnlSign}$${Math.abs(details.pnlUsd).toFixed(2)} (${pnlSign}${details.pnlPct.toFixed(2)}%)\n`;
                            msg += `   💎 Fees: $${details.unclaimedFeesUsd.toFixed(4)} | 💰 Value: $${details.totalValueUsd.toFixed(4)}\n`;
                            msg += `   ⏱ Age: ${ageMinutes}m | ⚙️ ${closeModeIcon}\n`;
                            msg += `   ${rangeStatus}\n`;
                            if (pos.entryReason) msg += `   💡 Reason: _${pos.entryReason}_\n`;
                        } else {
                            const closeModeIcon = (pos.closeMode || 'auto') === 'auto' ? '🤖 Auto' : '👤 Manual';
                            msg += `   Invested: ${investedStr} SOL\n`;
                            msg += `   ⏱ Age: ${ageMinutes}m | ⚙️ ${closeModeIcon}\n`;
                            if (pos.entryReason) msg += `   💡 Reason: _${pos.entryReason}_\n`;
                        }
                        msg += `\n`;
                        index++;
                    });
                }
                
                msg += `────────────────`;
                ctx.replyWithMarkdown(msg);
            }
        } catch (e) {
            ctx.reply("❌ Failed to read positions: " + e.message);
        }
    }

    // Command: /positions
    bot.command('positions', sendPositionsCommand);

    // Helper to setup solana connections
    function setupSolanaContext() {
        if (!process.env.WALLET_PRIVATE_KEY || process.env.WALLET_PRIVATE_KEY === 'your_wallet_private_key_base58') return null;
        const bs58 = require('bs58').default || require('bs58');
        const { Keypair, Connection } = require('@solana/web3.js');
        const decodedKey = bs58.decode(process.env.WALLET_PRIVATE_KEY);
        const walletKeypair = Keypair.fromSecretKey(decodedKey);
        const connection = new Connection(process.env.RPC_URL || 'https://api.mainnet-beta.solana.com', { commitment: 'confirmed' });
        return { walletKeypair, connection };
    }

    // Command: /open <token_mint> [amount]
    bot.command('open', async (ctx) => {
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
            
            // Balance Check
            const solBalanceLamports = await solCtx.connection.getBalance(solCtx.walletKeypair.publicKey);
            const solBalance = solBalanceLamports / 1e9;
            
            if (solBalance < minSolToOpen) {
                return ctx.reply(`❌ **Insufficient Balance**\nYour wallet balance is ${solBalance.toFixed(4)} SOL.\nMinimum required to open position (minSolToOpen) is ${minSolToOpen} SOL.`, { parse_mode: 'Markdown' });
            }

            const { fetchMeteoraPools, addLiquidity } = require('./solana-dex.cjs');
            const { addPosition } = require('./state.cjs');
            
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
            poolInfo += `\n⏳ Executing \`addLiquidity\` (${investAmountSol} SOL) in ${botMode.toUpperCase()} mode...`;
            ctx.reply(poolInfo, { parse_mode: 'Markdown' });
            
            const solLamports = Math.floor(investAmountSol * 1e9);
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
                addPosition({
                    tokenMint: tokenMint,
                    tokenSymbol: bestPool.symbol_x && bestPool.symbol_y ? `${bestPool.symbol_x}-${bestPool.symbol_y}` : "MANUAL_ENTRY",
                    poolAddress: bestPool.poolAddress,
                    positionPubKey: posPubKey,
                    investedSol: investAmountSol,
                    openedBy: 'manual',
                    entryReason: "Manual open from Telegram",
                    closeMode: "auto"
                });
                
                const { logTrade } = require('./state.cjs');
                logTrade('ENTRY', {
                    tokenMint,
                    tokenSymbol: bestPool.symbol_x && bestPool.symbol_y ? `${bestPool.symbol_x}-${bestPool.symbol_y}` : "MANUAL_ENTRY",
                    poolAddress: bestPool.poolAddress,
                    positionPubKey: posPubKey,
                    investedSol: investAmountSol,
                    entryReason: "Manual open from Telegram"
                });
                
                let successMsg = `🎉 *Position Opened!*\n`;
                successMsg += `• *Token*: ${tokenMint}\n`;
                successMsg += `• *Invested*: ${investAmountSol} SOL\n`;
                successMsg += `• *Strategy Type*: ${strategyType}\n`;
                successMsg += `• *Range*: ${minRange}% to ${maxRange}%\n`;
                successMsg += `• *Position Key*: \`${posPubKey}\``;
                await ctx.reply(successMsg, { parse_mode: 'Markdown' });
                
                // Panggil /positions otomatis
                await sendPositionsCommand(ctx);
            } else {
                ctx.reply(`❌ Failed to open position (no pubkey returned).`);
            }
        } catch (e) {
            ctx.reply(`❌ Error opening position: ${e.message}`);
        }
    });

    // Command: /close <position_number>
    bot.command('close', async (ctx) => {
        const text = ctx.message.text.trim();
        const parts = text.split(/\s+/);
        if (parts.length < 2) {
            return ctx.reply("❌ Invalid format. Use: /close <nomor_posisi>");
        }
        const index = parseInt(parts[1], 10) - 1;
        
        try {
            const { readState, removePosition } = require('./state.cjs');
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
            const txid = await removeLiquidity(solCtx.connection, solCtx.walletKeypair, pos.poolAddress, pos.positionPubKey, botMode);
            
            removePosition(pos.positionPubKey);
            const { logTrade } = require('./state.cjs');
            logTrade('EXIT', { ...pos, reason: "Manual close from Telegram" });
            const statusStr = typeof txid === 'string' ? txid : (txid && txid.status ? txid.status : 'success');
            ctx.reply(`✅ *Position Closed!*\nStatus/TxID: \`${statusStr}\``, { parse_mode: 'Markdown' });
        } catch (e) {
            ctx.reply(`❌ Error closing position: ${e.message}`);
        }
    });

    // Command: /close_all
    bot.command('close_all', async (ctx) => {
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
    });

    // Callback Action: Confirm Close All
    bot.action('confirm_close_all', async (ctx) => {
        try {
            await ctx.answerCbQuery();
        } catch (e) {}

        try {
            await ctx.editMessageText(`⏳ Memproses penutupan semua posisi...`);
        } catch (e) {}

        try {
            const { readState, removePosition } = require('./state.cjs');
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
                    await removeLiquidity(solCtx.connection, solCtx.walletKeypair, pos.poolAddress, pos.positionPubKey, botMode);
                    removePosition(pos.positionPubKey);
                    const { logTrade } = require('./state.cjs');
                    logTrade('EXIT', { ...pos, reason: "Manual close_all from Telegram" });
                } catch(err) {
                    ctx.reply(`❌ Failed to close ${pos.tokenSymbol}: ${err.message}`);
                }
            }
            ctx.reply(`✅ Finished /close_all operation.`);
        } catch (e) {
            ctx.reply(`❌ Error during close_all: ${e.message}`);
        }
    });

    // Callback Action: Cancel Close All
    bot.action('cancel_close_all', async (ctx) => {
        try {
            await ctx.answerCbQuery();
        } catch (e) {}
        try {
            await ctx.editMessageText(`❌ Operasi /close_all dibatalkan.`);
        } catch (e) {}
    });


    // Command: /history
    bot.command('history', async (ctx) => {
        try {
            const historyPath = path.join(__dirname, '..', 'trade_history.json');
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
                msg += `${idx + 1}. ${emoji} *${actionText}* - ${trade.tokenSymbol || 'Unknown'}\n`;
                if (trade.reason || trade.entryReason) {
                    msg += `   💡 Reason: _${trade.reason || trade.entryReason}_\n`;
                }
                const date = new Date(trade.timestamp).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
                msg += `   ⏱ Time: ${date}\n`;
                if (!isEntry && trade.reclaimedSol) {
                    msg += `   💰 Reclaimed: ${trade.reclaimedSol.toFixed(4)} SOL\n`;
                } else if (isEntry && trade.investedSol) {
                    msg += `   💰 Invested: ${trade.investedSol.toFixed(4)} SOL\n`;
                }
                msg += `\n`;
            });
            
            ctx.replyWithMarkdown(msg);
        } catch (e) {
            ctx.reply("❌ Error reading history: " + e.message);
        }
    });

    // Command: /toggle_close <position_number>
    bot.command('toggle_close', (ctx) => {
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
    });

    // Command: /toggle_auto
    bot.command('toggle_auto', (ctx) => {
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
                
                ctx.replyWithMarkdown(`⚙️ Bot Mode Changed!\nEntry Mode: *${newMode}*\nClose Mode: *${newMode}*`);
            } else {
                ctx.reply("❌ user-config.json not found.");
            }
        } catch (e) {
            ctx.reply("❌ Failed to toggle mode: " + e.message);
        }
    });

    // Command: /scrape
    bot.command('scrape', async (ctx) => {
        try {
            ctx.reply("⏳ Memulai proses screening/scraping secara manual...");
            const { runScraper } = require('./scraper.cjs');
            await runScraper();
            
            const candidatesPath = path.join(__dirname, '..', 'candidates.json');
            if (fs.existsSync(candidatesPath)) {
                let candidates = JSON.parse(fs.readFileSync(candidatesPath, 'utf-8'));
                if (candidates.length > 0) {
                    const { screenCandidates } = require('./ai-agent.cjs');
                    ctx.reply(`🔍 Ditemukan ${candidates.length} candidates. Requesting Hermes AI screening...`);
                    // AI Screening (Get top 3)
                    candidates = await screenCandidates(candidates, 3);
                    
                    let aiMsg = `🤖 *Hermes AI Selection (Top ${candidates.length})* 🤖\n━━━━━━━━━━━━━━━━━━\n`;
                    candidates.forEach((t, index) => {
                        const rankEmoji = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '💎';
                        const cleanName = t.name ? t.name.replace(/[_*`\[\]]/g, '') : 'Unknown';
                        const cleanReason = t.ai_reason ? t.ai_reason.replace(/[_*`\[\]]/g, '') : '';
                        aiMsg += `${rankEmoji} *${cleanName}* (${t.symbol})\n`;
                        aiMsg += `🔗 \`${t.address}\`\n`;
                        aiMsg += `💰 *MCap:* $${(t.market_cap / 1000).toFixed(1)}k | 👥 *Holders:* ${t.holder_count}\n`;
                        
                        let statsStr = `📈 *Vol:* $${(t.volume / 1000).toFixed(1)}k | 🧠 *Degens:* ${t.smart_degen_count}`;
                        if (t.latestSupertrend !== undefined) statsStr += `\n📊 *ST:* ${Number(t.latestSupertrend).toFixed(6)}`;
                        if (t.volumeTrend !== undefined) statsStr += ` | 🌊 *Vol Trend:* ${t.volumeTrend} (${(t.volumeChangePercent || 0).toFixed(1)}%)`;
                        aiMsg += `${statsStr}\n`;
                        
                        if (cleanReason) aiMsg += `💡 *Reason:* _${cleanReason}_\n`;
                        aiMsg += `━━━━━━━━━━━━━━━━━━\n`;
                    });
                    ctx.replyWithMarkdown(aiMsg);
                }
            }
            
            ctx.reply("✅ Proses screening selesai. Anda bisa menggunakan /open untuk entry manual.");
        } catch (e) {
            ctx.reply("❌ Error saat scraping: " + e.message);
        }
    });

    // Command: /chat
    bot.command('chat', async (ctx) => {
        const messageText = ctx.message.text.replace(/^\/chat\s*/, '').trim();
        if (!messageText) {
            return ctx.reply("Please provide a message. Example: /chat What is the best strategy today?");
        }
        
        ctx.reply("🤖 Thinking...");
        try {
            const { askAI } = require('./ai-agent.cjs');
            const aiResponse = await askAI(messageText);
            ctx.replyWithMarkdown(aiResponse);
        } catch (e) {
            ctx.reply("❌ AI Error: " + e.message);
        }
    });

    bot.catch((err, ctx) => {
        console.error(`Ooops, encountered an error for ${ctx.updateType}`, err);
    });

    bot.launch().then(() => {
        console.log("Telegram Bot started with Telegraf!");
        bot.telegram.setMyCommands([
            { command: 'help', description: 'Show available commands' },
            { command: 'positions', description: 'List active positions' },
            { command: 'history', description: 'View trade history' },
            { command: 'toggle_close', description: 'Toggle close mode per position' },
            { command: 'open', description: 'Open position (/open <mint> [sol])' },
            { command: 'close', description: 'Close position (/close <number>)' },
            { command: 'close_all', description: 'Close all positions' },
            { command: 'toggle_auto', description: 'Toggle Global Auto Entry/Close Mode' },
            { command: 'scrape', description: 'Force run scraper and AI screening' },
            { command: 'chat', description: 'Chat with Hermes AI Analyst' }
        ]).catch(e => console.error("Failed to set commands:", e.message));
    }).catch((e) => {
        console.error("Failed to launch Telegraf bot:", e.message);
    });

    // Enable graceful stop
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
} else {
    console.warn("Telegram Token missing or default. Telegram Bot disabled.");
}

function sendMessage(text) {
    if (bot && chatId) {
        bot.telegram.sendMessage(chatId, text, { parse_mode: 'Markdown' })
            .catch(e => console.error("Telegram Error:", e.message));
    } else {
        console.log(`[Telegram] ${text}`);
    }
}

module.exports = {
    sendMessage
};
