const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

let bot = null;

if (token && token !== 'your_telegram_bot_token') {
    bot = new TelegramBot(token, { polling: true });

    bot.onText(/\/toggle_auto/, (msg) => {
        const fs = require('fs');
        const configPath = path.join(__dirname, '..', 'user-config.json');
        if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            config.monitoringConfig.autoEntryEnabled = !config.monitoringConfig.autoEntryEnabled;
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
            sendMessage(`✅ Auto Entry is now: *${config.monitoringConfig.autoEntryEnabled ? 'ON' : 'OFF'}*`);
        }
    });

    bot.onText(/\/chat (.+)/, async (msg, match) => {
        const resp = match[1];
        const { askAI } = require('./ai-agent.cjs');
        try {
            sendMessage("🤖 Hermes is thinking...");
            const answer = await askAI(resp);
            sendMessage(`*Hermes:* ${answer}`);
        } catch (e) {
            sendMessage(`❌ Error: ${e.message}`);
        }
    });
    
    console.log("Telegram Bot started.");
} else {
    console.warn("Telegram Token not configured. Running in silent mode.");
}

function sendMessage(text) {
    if (bot && chatId) {
        bot.sendMessage(chatId, text, { parse_mode: 'Markdown' }).catch(e => console.error("Telegram Error:", e.message));
    } else {
        console.log(`[Telegram] ${text}`);
    }
}

module.exports = {
    sendMessage
};
