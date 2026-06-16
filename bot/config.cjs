const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, '..', 'user-config.json');

function getConfig() {
    try {
        if (!fs.existsSync(configPath)) {
            console.error("user-config.json not found!");
            return {};
        }
        return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (e) {
        console.error("Error reading config:", e.message);
        return {};
    }
}

function updateConfig(keyPath, value) {
    try {
        const config = getConfig();
        const keys = keyPath.split('.');
        let current = config;
        
        for (let i = 0; i < keys.length - 1; i++) {
            if (!(keys[i] in current) || typeof current[keys[i]] !== 'object') {
                current[keys[i]] = {};
            }
            current = current[keys[i]];
        }
        
        const lastKey = keys[keys.length - 1];
        current[lastKey] = value;
        
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        return true;
    } catch (e) {
        console.error("Error writing config:", e.message);
        return false;
    }
}

function getBotMode() {
    const config = getConfig();
    return config.botMode || 'live';
}

module.exports = {
    getConfig,
    updateConfig,
    getBotMode,
    configPath
};
