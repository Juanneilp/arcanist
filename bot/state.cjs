const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '..', 'active_positions.json');

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

function addPosition(positionObj) {
    const state = readState();
    state.push({
        ...positionObj,
        timestamp: Date.now()
    });
    saveState(state);
}

function removePosition(positionPubKey) {
    const state = readState();
    const newState = state.filter(p => p.positionPubKey !== positionPubKey);
    saveState(newState);
}

function updatePosition(positionPubKey, updateData) {
    const state = readState();
    const idx = state.findIndex(p => p.positionPubKey === positionPubKey);
    if (idx !== -1) {
        state[idx] = { ...state[idx], ...updateData };
        saveState(state);
    }
}

module.exports = {
    readState,
    saveState,
    addPosition,
    removePosition,
    updatePosition
};
