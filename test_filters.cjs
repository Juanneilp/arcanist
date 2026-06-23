const { execSync } = require("child_process");

const address = "7kkQU6AhUadtoszttEKprirvpgBihJHPoHVczebvi7i3";
const filtersToTest = [
    [],
    ['--filter', 'has_social'],
    ['--filter', 'dexscr_update_link'],
    ['--filter', 'not_wash_trading'],
    ['--filter', 'burn']
];

for (const filterArgs of filtersToTest) {
    try {
        const args = ['npx', 'gmgn-cli', 'market', 'trending', '--chain', 'sol', '--interval', '24h', '--platform', 'Pump.fun', '--limit', '1000', '--raw', ...filterArgs].join(' ');
        const out = execSync(args, { stdio: 'pipe' });
        const res = JSON.parse(out.toString());
        const token = res.data.rank.find(t => t.address === address);
        console.log(`Filters [${filterArgs.join(' ')}]: ${token ? 'FOUND (Rank: ' + res.data.rank.indexOf(token) + ')' : 'NOT FOUND'}`);
    } catch(e) {
        console.error(`Error with filters [${filterArgs.join(' ')}]:`, e.message);
    }
}
