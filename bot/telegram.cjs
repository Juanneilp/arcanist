const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Telegraf } = require('telegraf');

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
                        `/toggle_auto - Toggle Auto Entry/Close Mode\n` +
                        `/chat [message] - Chat with Hermes AI Analyst`;
        ctx.reply(helpMsg);
    });
    bot.start((ctx) => ctx.reply("Welcome to Arcanist Bot! Type /help to see available commands."));

    // Command: /positions
    bot.command('positions', async (ctx) => {
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

            // Removed aggressive state mutation here. 
            // The bot loop should be the only one managing the lifecycle and auto-deleting closed positions.
            // meteoraDetails will simply be used for augmenting the UI if the position data is found.

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
                        const details = meteoraDetails ? meteoraDetails[pos.positionPubKey] : null;
                        const investedStr = typeof pos.investedSol === 'number' ? pos.investedSol.toFixed(4) : pos.investedSol;
                        const ageMinutes = pos.timestamp ? Math.floor((Date.now() - pos.timestamp) / 60000) : 0;
                        
                        msg += `${index}. 🤖 *${pos.tokenSymbol}-SOL*\n`;
                        if (details) {
                            const pnlSign = details.pnlUsd >= 0 ? "+" : "";
                            const pnlColor = details.pnlUsd >= 0 ? "🟢" : "🔴";
                            const rangeStatus = details.inRange ? "✅ In Range" : "⚠️ OOR";
                            
                            msg += `   ${pnlColor} PnL: ${pnlSign}$${Math.abs(details.pnlUsd).toFixed(2)} (${pnlSign}${details.pnlPct.toFixed(2)}%)\n`;
                            msg += `   💎 Fees: $${details.unclaimedFeesUsd.toFixed(4)} | 💰 Value: $${details.totalValueUsd.toFixed(4)}\n`;
                            msg += `   ⏱ Age: ${ageMinutes}m\n`;
                            msg += `   ${rangeStatus}\n`;
                        } else {
                            msg += `   Invested: ${investedStr} SOL\n`;
                            msg += `   ⏱ Age: ${ageMinutes}m\n`;
                        }
                        msg += `\n`;
                        index++;
                    });
                }
                
                if (manualPositions.length > 0) {
                    msg += `*Manual Positions*\n`;
                    manualPositions.forEach(pos => {
                        const details = meteoraDetails ? meteoraDetails[pos.positionPubKey] : null;
                        const investedStr = typeof pos.investedSol === 'number' ? pos.investedSol.toFixed(4) : pos.investedSol;
                        const ageMinutes = pos.timestamp ? Math.floor((Date.now() - pos.timestamp) / 60000) : 0;
                        
                        msg += `${index}. 👤 *${pos.tokenSymbol}/SOL* 🔒\n`;
                        if (details) {
                            const pnlSign = details.pnlUsd >= 0 ? "+" : "";
                            const pnlColor = details.pnlUsd >= 0 ? "🟢" : "🔴";
                            const rangeStatus = details.inRange ? "✅ In Range" : "⚠️ OOR";
                            
                            msg += `   ${pnlColor} PnL: ${pnlSign}$${Math.abs(details.pnlUsd).toFixed(2)} (${pnlSign}${details.pnlPct.toFixed(2)}%)\n`;
                            msg += `   💎 Fees: $${details.unclaimedFeesUsd.toFixed(4)} | 💰 Value: $${details.totalValueUsd.toFixed(4)}\n`;
                            msg += `   ⏱ Age: ${ageMinutes}m\n`;
                            msg += `   ${rangeStatus}\n`;
                        } else {
                            msg += `   Invested: ${investedStr} SOL\n`;
                            msg += `   ⏱ Age: ${ageMinutes}m\n`;
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
    });

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
            ctx.reply(`✅ Found Pool: \`${bestPool.poolAddress}\`\n⏳ Executing \`addLiquidity\` (${investAmountSol} SOL) in ${botMode.toUpperCase()} mode...`, { parse_mode: 'Markdown' });
            
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
                addPosition({
                    tokenMint: tokenMint,
                    tokenSymbol: "MANUAL_ENTRY",
                    poolAddress: bestPool.poolAddress,
                    positionPubKey: typeof positionPubKeyStr === 'string' ? positionPubKeyStr : positionPubKeyStr.status || "Unknown",
                    investedSol: investAmountSol,
                    openedBy: 'manual'
                });
                ctx.reply(`🎉 *Position Opened!*\nStatus/Position: \`${typeof positionPubKeyStr === 'string' ? positionPubKeyStr : positionPubKeyStr.status}\``, { parse_mode: 'Markdown' });
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
            const statusStr = typeof txid === 'string' ? txid : (txid && txid.status ? txid.status : 'success');
            ctx.reply(`✅ *Position Closed!*\nStatus/TxID: \`${statusStr}\``, { parse_mode: 'Markdown' });
        } catch (e) {
            ctx.reply(`❌ Error closing position: ${e.message}`);
        }
    });

    // Command: /close_all
    bot.command('close_all', async (ctx) => {
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
                } catch(err) {
                    ctx.reply(`❌ Failed to close ${pos.tokenSymbol}: ${err.message}`);
                }
            }
            ctx.reply(`✅ Finished /close_all operation.`);
        } catch (e) {
            ctx.reply(`❌ Error during close_all: ${e.message}`);
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
            { command: 'open', description: 'Open position (/open <mint> [sol])' },
            { command: 'close', description: 'Close position (/close <number>)' },
            { command: 'close_all', description: 'Close all positions' },
            { command: 'toggle_auto', description: 'Toggle Auto Entry/Close Mode' },
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
