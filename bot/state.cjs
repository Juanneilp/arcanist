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
        if (fs.existsSync(STATE_FILE)) release = lockfile.lockSync(STATE_FILE, { stale: 5000 });
    } catch(e) {
        console.error("Lock error in addPosition", e.message);
    }
    
    try {
        const state = readState();
        
        // GUARD: Prevent duplicate positionPubKey
        const existingIdx = state.findIndex(p => p.positionPubKey === positionObj.positionPubKey);
        if (existingIdx !== -1) {
            // If existing is manual and new is auto, upgrade to auto (preserve AI reason & data)
            if (state[existingIdx].openedBy === 'manual' && positionObj.openedBy === 'auto') {
                state[existingIdx] = { ...state[existingIdx], ...positionObj, timestamp: state[existingIdx].timestamp };
                console.log(`[State] Upgraded manual position to auto: ${positionObj.positionPubKey}`);
            } else {
                console.log(`[State] Duplicate positionPubKey detected, skipping: ${positionObj.positionPubKey}`);
            }
            saveState(state);
            return;
        }
        
        state.push({
            ...positionObj,
            timestamp: Date.now()
        });
        saveState(state);
    } catch(e) {
        console.error("Error in addPosition state modification", e.message);
    } finally {
        if (release) release();
    }
}

function removePosition(positionPubKey) {
    let release;
    try {
        if (fs.existsSync(STATE_FILE)) release = lockfile.lockSync(STATE_FILE, { stale: 5000 });
    } catch(e) {
        console.error("Lock error in removePosition", e.message);
    }
    
    try {
        const state = readState();
        const newState = state.filter(p => p.positionPubKey !== positionPubKey);
        saveState(newState);
    } catch(e) {
        console.error("Error in removePosition state modification", e.message);
    } finally {
        if (release) release();
    }
}

function updatePosition(positionPubKey, updateData) {
    let release;
    try {
        if (fs.existsSync(STATE_FILE)) release = lockfile.lockSync(STATE_FILE, { stale: 5000 });
    } catch(e) {
        console.error("Lock error in updatePosition", e.message);
    }
    
    try {
        const state = readState();
        const idx = state.findIndex(p => p.positionPubKey === positionPubKey);
        if (idx !== -1) {
            state[idx] = { ...state[idx], ...updateData };
            saveState(state);
        }
    } catch(e) {
        console.error("Error in updatePosition state modification", e.message);
    } finally {
        if (release) release();
    }
}

function logTrade(action, positionData) {
    let release;
    try {
        if (fs.existsSync(TRADE_LOG_FILE)) release = lockfile.lockSync(TRADE_LOG_FILE, { stale: 5000 });
    } catch(e) {
        console.error("Lock error in logTrade", e.message);
    }
    
    try {
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
        console.error("Error in logTrade state modification", e.message);
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
