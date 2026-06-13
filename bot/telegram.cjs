const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

console.warn("Telegram Bot polling disabled temporarily due to module issues. Sending messages is supported.");

function sendMessage(text) {
    if (token && token !== 'your_telegram_bot_token' && chatId) {
        const url = `https://api.telegram.org/bot${token}/sendMessage`;
        fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: text,
                parse_mode: 'Markdown'
            })
        }).catch(e => console.error("Telegram Error:", e.message));
    } else {
        console.log(`[Telegram] ${text}`);
    }
}

module.exports = {
    sendMessage
};
