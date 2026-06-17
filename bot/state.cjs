const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '..', 'active_positions.json');
const TRADE_LOG_FILE = path.join(__dirname, '..', 'trade_history.json');

function readState() {
    if (!fs.existsSync(STATE_FILE)) {
        return [];
    }
    try {
        const raw = fs.readFileSync(STATE_FILE, 'utf-8');
        return JSON.parse(raw);
    } catch (e) {
        console.error('Failed to read state:', e);
        return [];
    }
}

function saveState(state) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

const lockfile = require('proper-lockfile');

function addPosition(positionObj) {
    let release;
    try {
        if (fs.existsSync(STATE_FILE)) release = lockfile.lockSync(STATE_FILE, { retries: 5 });
        const state = readState();
        state.push({
            ...positionObj,
            timestamp: Date.now()
        });
        saveState(state);
    } catch(e) {
        console.error("Lock error in addPosition", e.message);
    } finally {
        if (release) release();
    }
}

function removePosition(positionPubKey) {
    let release;
    try {
        if (fs.existsSync(STATE_FILE)) release = lockfile.lockSync(STATE_FILE, { retries: 5 });
        const state = readState();
        const newState = state.filter(p => p.positionPubKey !== positionPubKey);
        saveState(newState);
    } catch(e) {
        console.error("Lock error in removePosition", e.message);
    } finally {
        if (release) release();
    }
}

function updatePosition(positionPubKey, updateData) {
    let release;
    try {
        if (fs.existsSync(STATE_FILE)) release = lockfile.lockSync(STATE_FILE, { retries: 5 });
        const state = readState();
        const idx = state.findIndex(p => p.positionPubKey === positionPubKey);
        if (idx !== -1) {
            state[idx] = { ...state[idx], ...updateData };
            saveState(state);
        }
    } catch(e) {
        console.error("Lock error in updatePosition", e.message);
    } finally {
        if (release) release();
    }
}

function logTrade(action, positionData) {
    let release;
    try {
        if (fs.existsSync(TRADE_LOG_FILE)) release = lockfile.lockSync(TRADE_LOG_FILE, { retries: 5 });
        let history = [];
        if (fs.existsSync(TRADE_LOG_FILE)) {
            try {
                const raw = fs.readFileSync(TRADE_LOG_FILE, 'utf-8');
                history = JSON.parse(raw);
            } catch (e) {}
        }
        
        const now = new Date();
        history.push({
            action, // 'ENTRY' or 'EXIT'
            timestamp: now.getTime(),
            timeStr: now.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) + ' WIB',
            ...positionData
        });
        
        fs.writeFileSync(TRADE_LOG_FILE, JSON.stringify(history, null, 2));
    } catch(e) {
        console.error("Lock error in logTrade", e.message);
    } finally {
        if (release) release();
    }
}

module.exports = {
    readState,
    saveState,
    addPosition,
    removePosition,
    updatePosition,
    logTrade
};
