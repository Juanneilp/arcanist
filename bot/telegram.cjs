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
    bot.command('positions', (ctx) => {
        try {
            const { readState } = require('./state.cjs');
            const currentActivePositions = readState();
            if (currentActivePositions.length === 0) {
                ctx.replyWithMarkdown(`ℹ️ *Status Report*\nCurrently 0 active positions.`);
            } else {
                let msg = `📊 *Status Report (${currentActivePositions.length} Active Positions)*\n\n`;
                currentActivePositions.forEach((pos, i) => {
                    msg += `${i+1}. *${pos.tokenSymbol}*\n   Pool: \`${pos.poolAddress}\`\n   Invested: ${pos.investedSol} SOL\n\n`;
                });
                ctx.replyWithMarkdown(msg);
            }
        } catch (e) {
            ctx.reply("❌ Failed to read positions: " + e.message);
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
