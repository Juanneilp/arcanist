const fs = require('fs');
const path = require('path');
const { getKline } = require('./bot/gmgn-client.cjs');

const address = process.argv[2];

function calculateATR(data, period) {
    let atr = [];
    let tr = [];
    for (let i = 0; i < data.length; i++) {
        if (i === 0) {
            tr.push(data[i].high - data[i].low);
        } else {
            const highLow = data[i].high - data[i].low;
            const highClose = Math.abs(data[i].high - data[i - 1].close);
            const lowClose = Math.abs(data[i].low - data[i - 1].close);
            tr.push(Math.max(highLow, highClose, lowClose));
        }
    }
    let sum = 0;
    for (let i = 0; i < period; i++) sum += tr[i];
    for (let i = 0; i < period - 1; i++) atr.push(null);
    atr.push(sum / period);
    for (let i = period; i < data.length; i++) {
        atr.push((atr[i - 1] * (period - 1) + tr[i]) / period);
    }
    return atr;
}

function calculateSupertrend(data, period, multiplier) {
    if (!data || data.length < period) return null;
    const atr = calculateATR(data, period);
    let upperband = new Array(data.length).fill(null);
    let lowerband = new Array(data.length).fill(null);
    let supertrend = new Array(data.length).fill(null);
    let trend = new Array(data.length).fill(1); 
    for (let i = period; i < data.length; i++) {
        const hl2 = (data[i].high + data[i].low) / 2;
        const basicUb = hl2 + (multiplier * atr[i]);
        const basicLb = hl2 - (multiplier * atr[i]);
        if (i === period) {
            upperband[i] = basicUb;
            lowerband[i] = basicLb;
            supertrend[i] = upperband[i]; 
        } else {
            if (basicUb < upperband[i - 1] || data[i - 1].close > upperband[i - 1]) upperband[i] = basicUb;
            else upperband[i] = upperband[i - 1];
            if (basicLb > lowerband[i - 1] || data[i - 1].close < lowerband[i - 1]) lowerband[i] = basicLb;
            else lowerband[i] = lowerband[i - 1];
        }
        if (i === period) {
            trend[i] = data[i].close > upperband[i] ? 1 : -1;
        } else {
            if (supertrend[i - 1] === upperband[i - 1] && data[i].close > upperband[i]) trend[i] = 1;
            else if (supertrend[i - 1] === lowerband[i - 1] && data[i].close < lowerband[i]) trend[i] = -1;
            else trend[i] = trend[i - 1];
        }
        if (trend[i] === 1) supertrend[i] = lowerband[i];
        else supertrend[i] = upperband[i];
    }
    return { trend, supertrend, upperband, lowerband };
}

async function fetchKlineData(tokenAddress, timeframe) {
    try {
        const response = await getKline({
            chain: 'sol',
            address: tokenAddress,
            resolution: timeframe,
        });
        if (response && response.list) return response.list;
        return null;
    } catch (e) {
        console.error(e);
        return null;
    }
}

async function checkToken() {
    const configPath = path.join(__dirname, 'user-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const techFilters = config.technicalFilters || {};
    const stConf = techFilters.supertrend || { enabled: false };

    console.log(`Checking Supertrend for token: ${address} (Timeframe: ${stConf.timeframe}, Period: ${stConf.period}, Mult: ${stConf.multiplier})`);
    
    const klines = await fetchKlineData(address, stConf.timeframe);
    if (!klines || klines.length === 0) {
        console.log(`Failed to fetch K-Line data.`);
        return;
    }

    const sortedKlines = klines.sort((a, b) => a.time - b.time).map(k => ({
        open: parseFloat(k.open),
        high: parseFloat(k.high),
        low: parseFloat(k.low),
        close: parseFloat(k.close),
        volume: parseFloat(k.volume) || 0
    }));

    let passST = true;
    let latestSupertrend = 0;
    let latestPrice = sortedKlines[sortedKlines.length - 1].close;

    const result = calculateSupertrend(sortedKlines, stConf.period, stConf.multiplier);
    if (!result || result.trend.length === 0) {
        console.log(`Not enough data for Supertrend.`);
        return;
    }
    
    const latestTrend = result.trend[result.trend.length - 1];
    latestSupertrend = result.supertrend[result.supertrend.length - 1];
    if (latestTrend !== 1) {
        passST = false;
        console.log(`FAIL (Red Supertrend) - Price: $${latestPrice}, ST: $${latestSupertrend}`);
    } else {
        console.log(`PASS (Green Supertrend) - Price: $${latestPrice}, ST: $${latestSupertrend}`);
    }
}

checkToken();
