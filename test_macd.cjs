const { calculateMACD, calculateRSI } = require('./bot/indicators.cjs');
const { execFile } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);

async function test() {
    const chain = 'sol';
    const address = '2djJnftE2WntTfH2P3k3DndmKjKxZ1Tnb7x6gVxgpump'; // TURTLE token from screenshot?
    const fromTimestamp = Math.floor(Date.now() / 1000) - (48 * 60 * 60);
    const apiKey = process.env.GMGN_API_KEY || 'gmgn_solbscbaseethmonadtron';
    
    try {
        const { stdout } = await execFileAsync('npx', [
            'gmgn-cli', 'market', 'kline', 
            '--chain', chain, 
            '--address', address, 
            '--resolution', '15m', 
            '--from', fromTimestamp.toString(), 
            '--raw'
        ], {
            env: { ...process.env, GMGN_API_KEY: apiKey },
            maxBuffer: 1024 * 1024 * 10
        });
        const response = JSON.parse(stdout);
        
        const sortedKlines = response.list.sort((a, b) => a.time - b.time);
        const closes = sortedKlines.map(k => parseFloat(k.close));
        
        const rsi = calculateRSI(closes, 2);
        const macd = calculateMACD(closes, 12, 26, 9);
        
        const lastIdx = closes.length - 1;
        console.log("Last candle close:", closes[lastIdx]);
        console.log("Last RSI(2):", rsi[lastIdx], rsi[lastIdx - 1], rsi[lastIdx - 2]);
        console.log("Last MACD Hist:", macd.histogram[lastIdx], macd.histogram[lastIdx - 1], macd.histogram[lastIdx - 2]);
        console.log("Last MACD Line:", macd.macdLine[lastIdx]);
        console.log("Last Signal Line:", macd.signalLine[lastIdx]);
    } catch(e) {
        console.error(e);
    }
}
test();
