const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Telegraf } = require('telegraf');
const handlers = require('./telegram-handlers.cjs');

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

let bot;
if (token && token !== 'your_telegram_bot_token') {
    bot = new Telegraf(token);
    
    // Command: /start or /help
    bot.help(handlers.authGuard, (ctx) => {
        const helpMsg = `🤖 Arcanist Bot Commands 🤖\n\n` +
                        `/positions - List active positions\n` +
                        `/history - View recent trade history\n` +
                        `/toggle_close <num> - Toggle close mode per posisi\n` +
                        `/toggle_auto - Toggle Global Auto Entry/Close Mode\n` +
                        `/scrape - Force run scraper & AI screening\n` +
                        `/getconfig [key] - View bot configuration\n` +
                        `/setconfig <key> <value> - Update bot configuration\n` +
                        `/blacklist <address> - Add token to blacklist\n` +
                        `/unblacklist <address> - Remove token from blacklist\n` +
                        `/chat [message] - Chat with Hermes AI Analyst`;
        ctx.reply(helpMsg);
    });
    bot.start(handlers.authGuard, (ctx) => ctx.reply("Welcome to Arcanist Bot! Type /help to see available commands."));

    // Commands
    bot.command('positions', handlers.authGuard, handlers.sendPositionsCommand);
    bot.command('open', handlers.authGuard, handlers.openCommand);
    bot.command('close', handlers.authGuard, handlers.closeCommand);
    bot.command('close_all', handlers.authGuard, handlers.closeAllCommand);
    bot.command('history', handlers.authGuard, handlers.historyCommand);
    bot.command('toggle_close', handlers.authGuard, handlers.toggleCloseCommand);
    bot.command('toggle_auto', handlers.authGuard, handlers.toggleAutoCommand);
    bot.command('scrape', handlers.authGuard, handlers.scrapeCommand);
    bot.command('getconfig', handlers.authGuard, handlers.getConfigCommand);
    bot.command('setconfig', handlers.authGuard, handlers.setConfigCommand);
    bot.command('blacklist', handlers.authGuard, handlers.blacklistCommand);
    bot.command('unblacklist', handlers.authGuard, handlers.unblacklistCommand);
    bot.command('chat', handlers.authGuard, handlers.chatCommand);

    // Actions
    bot.action('confirm_close_all', handlers.authGuard, handlers.confirmCloseAllAction);
    bot.action('cancel_close_all', handlers.authGuard, handlers.cancelCloseAllAction);

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
            { command: 'getconfig', description: 'View config (/getconfig [key])' },
            { command: 'setconfig', description: 'Modify config (/setconfig <key> <value>)' },
            { command: 'chat', description: 'Chat with Hermes AI Analyst' },
            { command: 'blacklist', description: 'Add token to blacklist' },
            { command: 'unblacklist', description: 'Remove token from blacklist' }
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
