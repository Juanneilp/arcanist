const { execSync } = require("child_process");

const address = "7kkQU6AhUadtoszttEKprirvpgBihJHPoHVczebvi7i3";

const tests = [
    { name: "Default (24h, Pump.fun)", args: ['--chain', 'sol', '--interval', '24h', '--platform', 'Pump.fun', '--limit', '1000', '--raw'] },
    { name: "No platform (24h)", args: ['--chain', 'sol', '--interval', '24h', '--limit', '1000', '--raw'] },
    { name: "1h interval (Pump.fun)", args: ['--chain', 'sol', '--interval', '1h', '--platform', 'Pump.fun', '--limit', '1000', '--raw'] },
    { name: "5m interval (Pump.fun)", args: ['--chain', 'sol', '--interval', '5m', '--platform', 'Pump.fun', '--limit', '1000', '--raw'] },
];

for (const test of tests) {
    try {
        const cmdArgs = ['npx', 'gmgn-cli', 'market', 'trending', ...test.args].join(' ');
        const out = execSync(cmdArgs, { stdio: 'pipe' });
        const res = JSON.parse(out.toString());
        const token = res.data.rank.find(t => t.address === address);
        console.log(`${test.name}: ${token ? 'FOUND (Rank: ' + res.data.rank.indexOf(token) + ')' : 'NOT FOUND'}`);
    } catch(e) {
        console.error(`Error with ${test.name}:`, e.message);
    }
}
