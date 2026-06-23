const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const configPath = path.join(__dirname, 'user-config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
const apiSettings = config.apiSettings;

const args = [
    'gmgn-cli', 'market', 'trending', 
    '--chain', apiSettings.chain, 
    '--interval', apiSettings.interval, 
    '--limit', apiSettings.limit.toString()
];

if (apiSettings.platform) {
    if (Array.isArray(apiSettings.platform)) {
        apiSettings.platform.forEach(p => {
            args.push('--platform', p);
        });
    } else if (typeof apiSettings.platform === 'string') {
        const platforms = apiSettings.platform.split(',').map(s => s.trim());
        platforms.forEach(p => {
            args.push('--platform', p);
        });
    }
}

if (apiSettings.apiFilters && Array.isArray(apiSettings.apiFilters)) {
    apiSettings.apiFilters.forEach(filter => {
        args.push('--filter', filter);
    });
}
args.push('--raw');

console.log('Running npx with args:', args);
const res = spawnSync('npx', args, { encoding: 'utf-8' });
if (res.stdout) {
    try {
        const json = JSON.parse(res.stdout);
        const tokens = json.data.rank || [];
        const platforms = {};
        tokens.forEach(t => {
            platforms[t.launchpad_platform] = (platforms[t.launchpad_platform] || 0) + 1;
        });
        console.log('Platforms found in fetched tokens:', platforms);
    } catch(e) { console.error('Parse error:', e); }
} else {
    console.error('Error running:', res.stderr);
}
