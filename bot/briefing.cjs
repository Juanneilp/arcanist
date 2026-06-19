const fs = require('fs');
const path = require('path');
const { sendMessage } = require('./telegram.cjs');
const { readState } = require('./state.cjs');

const TRADE_LOG_FILE = path.join(__dirname, '..', 'trade_history.json');
const LAST_BRIEFING_FILE = path.join(__dirname, '..', 'last_briefing.json');

function getJakartaDateStr() {
    const d = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Jakarta"}));
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, '0') + "-" + String(d.getDate()).padStart(2, '0');
}

function getLastBriefingDate() {
    if (!fs.existsSync(LAST_BRIEFING_FILE)) return null;
    try {
        const data = JSON.parse(fs.readFileSync(LAST_BRIEFING_FILE, 'utf8'));
        return data.date;
    } catch(e) {
        return null;
    }
}

function setLastBriefingDate(dateStr) {
    fs.writeFileSync(LAST_BRIEFING_FILE, JSON.stringify({ date: dateStr }));
}

async function generateBriefing() {
    let tradeHistory = [];
    if (fs.existsSync(TRADE_LOG_FILE)) {
        try {
            tradeHistory = JSON.parse(fs.readFileSync(TRADE_LOG_FILE, 'utf8'));
        } catch(e) {}
    }
    
    const activePositions = readState();
    
    const now = Date.now();
    const last24h = now - 24 * 60 * 60 * 1000;
    
    const openedLast24h = tradeHistory.filter(t => t.action === 'ENTRY' && t.timestamp > last24h);
    const closedLast24h = tradeHistory.filter(t => t.action === 'EXIT' && t.timestamp > last24h);
    
    const totalPnLUsd = closedLast24h.reduce((sum, t) => sum + (t.pnlUsd || 0), 0);
    const wins = closedLast24h.filter(t => (t.pnlUsd || 0) > 0).length;
    const winRate = closedLast24h.length > 0 ? Math.round((wins / closedLast24h.length) * 100) : 0;
    
    const allTimePnLUsd = tradeHistory.filter(t => t.action === 'EXIT').reduce((sum, t) => sum + (t.pnlUsd || 0), 0);
    const allTimeWins = tradeHistory.filter(t => t.action === 'EXIT' && (t.pnlUsd || 0) > 0).length;
    const allTimeTotalCloses = tradeHistory.filter(t => t.action === 'EXIT').length;
    const allTimeWinRate = allTimeTotalCloses > 0 ? Math.round((allTimeWins / allTimeTotalCloses) * 100) : 0;

    const lines = [
        "☀️ *Morning Briefing* (Last 24h)",
        "────────────────",
        `*Activity:*`,
        `📥 Positions Opened: ${openedLast24h.length}`,
        `📤 Positions Closed: ${closedLast24h.length}`,
        "",
        `*Performance:*`,
        `💰 Net PnL: ${totalPnLUsd >= 0 ? "+" : ""}$${totalPnLUsd.toFixed(2)}`,
        closedLast24h.length > 0
            ? `📈 Win Rate (24h): ${winRate}%`
            : "📈 Win Rate (24h): N/A",
        "",
        `*Current Portfolio:*`,
        `📂 Open Positions: ${activePositions.length}`,
        `📊 All-time PnL: ${allTimePnLUsd >= 0 ? "+" : ""}$${allTimePnLUsd.toFixed(2)} (${allTimeWinRate}% win)`,
        "────────────────"
    ];
    
    const msg = lines.join('\n');
    await sendMessage(msg);
    
    const todayStr = getJakartaDateStr();
    setLastBriefingDate(todayStr);
}

module.exports = {
    generateBriefing,
    getLastBriefingDate,
    setLastBriefingDate,
    getJakartaDateStr
};
