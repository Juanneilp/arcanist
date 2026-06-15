const { exec, execFile } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const execAsync = util.promisify(exec);
const execFileAsync = util.promisify(execFile);

// --- SUPERTREND LOGIC ---
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
    for (let i = 0; i < period; i++) {
        sum += tr[i];
    }
    
    for (let i = 0; i < period - 1; i++) {
        atr.push(null);
    }
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
            if (basicUb < upperband[i - 1] || data[i - 1].close > upperband[i - 1]) {
                upperband[i] = basicUb;
            } else {
                upperband[i] = upperband[i - 1];
            }
            if (basicLb > lowerband[i - 1] || data[i - 1].close < lowerband[i - 1]) {
                lowerband[i] = basicLb;
            } else {
                lowerband[i] = lowerband[i - 1];
            }
        }
        
        if (i === period) {
            trend[i] = data[i].close > upperband[i] ? 1 : -1;
        } else {
            if (supertrend[i - 1] === upperband[i - 1] && data[i].close > upperband[i]) {
                trend[i] = 1;
            } else if (supertrend[i - 1] === lowerband[i - 1] && data[i].close < lowerband[i]) {
                trend[i] = -1;
            } else {
                trend[i] = trend[i - 1];
            }
        }
        
        if (trend[i] === 1) {
            supertrend[i] = lowerband[i];
        } else {
            supertrend[i] = upperband[i];
        }
    }
    return { trend, supertrend, upperband, lowerband };
}

function calculateVolumeTrend(klines, period, accThreshold, decThreshold) {
    if (!klines || klines.length < period * 2) return null;
    let recentVolumeSum = 0;
    for (let i = klines.length - period; i < klines.length; i++) {
        recentVolumeSum += klines[i].volume;
    }
    const recentAvg = recentVolumeSum / period;

    let prevVolumeSum = 0;
    for (let i = klines.length - (period * 2); i < klines.length - period; i++) {
        prevVolumeSum += klines[i].volume;
    }
    const prevAvg = prevVolumeSum / period;

    if (prevAvg === 0) return { trend: 'Stable', changePercent: 0 };
    const changePercent = ((recentAvg - prevAvg) / prevAvg) * 100;
    
    let trend = 'Stable';
    if (changePercent > accThreshold) trend = 'Accelerating';
    else if (changePercent < decThreshold) trend = 'Decelerating';

    return { trend, changePercent, recentAvg, prevAvg };
}

// --- SCRAPER LOGIC ---
const configPath = path.join(__dirname, '..', 'user-config.json');
let config;
try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
} catch (error) {
    console.error("Failed to read user-config.json.");
    process.exit(1);
}

const apiSettings = config.apiSettings;
const localFilters = config.localFilters;
const techFilters = config.technicalFilters || {};

console.log(`Starting GMGN Scraper...`);

const apiKey = process.env.GMGN_API_KEY || 'gmgn_solbscbaseethmonadtron';

async function fetchKlineData(address, timeframe) {
    try {
        const { stdout } = await execFileAsync('npx', [
            'gmgn-cli', 'market', 'kline',
            '--chain', apiSettings.chain,
            '--address', address,
            '--resolution', timeframe,
            '--raw'
        ], {
            env: { ...process.env, GMGN_API_KEY: apiKey },
            maxBuffer: 1024 * 1024 * 10
        });
        const response = JSON.parse(stdout);
        if (response.list) return response.list;
        return null;
    } catch (e) {
        return null;
    }
}

async function runScraper() {
    console.log(`Executing API Request for Trending Tokens...`);
    try {
        const args = [
            'gmgn-cli', 'market', 'trending', 
            '--chain', apiSettings.chain, 
            '--interval', apiSettings.interval, 
            '--platform', apiSettings.platform, 
            '--limit', apiSettings.limit.toString()
        ];
        
        if (apiSettings.apiFilters && Array.isArray(apiSettings.apiFilters)) {
            apiSettings.apiFilters.forEach(filter => {
                args.push('--filter', filter);
            });
        }
        args.push('--raw');

        const { stdout } = await execFileAsync('npx', args, {
            env: { ...process.env, GMGN_API_KEY: apiKey },
            maxBuffer: 1024 * 1024 * 10
        });
        const response = JSON.parse(stdout);
        if (response.code !== 0) return console.error(`API Error: ${response.msg}`);

        const tokens = response.data.rank || [];
        const fundamentalFilteredTokens = tokens.filter(token => {
            const marketCap = parseFloat(token.market_cap) || 0;
            const volume24h = parseFloat(token.volume) || 0; 
            const gasFee = parseFloat(token.gas_fee) || 0; 
            const smartDegenCount = parseInt(token.smart_degen_count, 10) || 0;
            const holderCount = parseInt(token.holder_count, 10) || 0;
            const creationTimestamp = parseInt(token.creation_timestamp, 10) || parseInt(token.open_timestamp, 10) || 0;
            
            let ageInHours = 0;
            if (creationTimestamp > 0) {
                ageInHours = (Math.floor(Date.now() / 1000) - creationTimestamp) / 3600;
            }

            return marketCap >= localFilters.minMarketCap && 
                   volume24h >= localFilters.minVolume24h &&
                   gasFee >= localFilters.minTotalFees &&
                   smartDegenCount >= localFilters.minSmartDegenCount &&
                   holderCount >= localFilters.minHolders &&
                   ageInHours >= (localFilters.minTokenAgeHours || 0);
        });

        const finalTokens = [];
        const stConf = techFilters.supertrend || { enabled: false };
        const vtConf = techFilters.volumeTrend || { enabled: false };

        if (stConf.enabled || vtConf.enabled) {
            const timeframe = stConf.enabled ? stConf.timeframe : "15m";
            for (let i = 0; i < fundamentalFilteredTokens.length; i++) {
                const token = fundamentalFilteredTokens[i];
                process.stdout.write(`[${i+1}/${fundamentalFilteredTokens.length}] Checking chart for ${token.symbol}... `);
                
                const klines = await fetchKlineData(token.address, timeframe);
                if (!klines || klines.length === 0) {
                    console.log(`Failed to fetch K-Line data.`);
                    continue;
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

                if (stConf.enabled) {
                    const result = calculateSupertrend(sortedKlines, stConf.period, stConf.multiplier);
                    if (!result || result.trend.length === 0) {
                        console.log(`Not enough data for Supertrend.`);
                        continue;
                    }
                    const latestTrend = result.trend[result.trend.length - 1];
                    latestSupertrend = result.supertrend[result.supertrend.length - 1];
                    if (latestTrend !== 1) {
                        passST = false;
                        console.log(`FAIL (Red Supertrend) - Price: $${latestPrice}, ST: $${latestSupertrend}`);
                    }
                }

                if (!passST) continue;

                let passVT = true;
                let volumeTrendStatus = 'N/A';
                let vtChange = 0;

                if (vtConf.enabled) {
                    const vtResult = calculateVolumeTrend(sortedKlines, vtConf.period || 3, vtConf.acceleratingThreshold || 10, vtConf.deceleratingThreshold || -10);
                    if (vtResult) {
                        volumeTrendStatus = vtResult.trend;
                        vtChange = vtResult.changePercent;
                        if (volumeTrendStatus === 'Decelerating') {
                            passVT = false;
                            console.log(`FAIL (Decelerating Volume: ${vtChange.toFixed(2)}%)`);
                        }
                    } else {
                         console.log(`Not enough data for Volume Trend.`);
                         passVT = false;
                    }
                }

                if (!passVT) continue;

                console.log(`PASS (ST Hijau, Vol ${volumeTrendStatus}) - Price: $${latestPrice}`);
                if (stConf.enabled) token.latestSupertrend = latestSupertrend;
                token.latestPrice = latestPrice;
                if (vtConf.enabled) {
                    token.volumeChangePercent = vtChange;
                    token.volumeTrend = volumeTrendStatus;
                }
                
                // ATH Detection: if current market cap is >= 95% of all time high market cap
                const currentMcap = parseFloat(token.market_cap) || 0;
                const athMcap = parseFloat(token.history_highest_market_cap) || 0;
                if (athMcap > 0 && currentMcap >= athMcap * 0.95) {
                    token.is_new_ath = true;
                    console.log(`🚀 [NEW ATH DETECTED] ${token.symbol} is at or near All-Time High!`);
                } else {
                    token.is_new_ath = false;
                }
                
                finalTokens.push(token);
            }
        } else {
            finalTokens.push(...fundamentalFilteredTokens);
        }

        const outputPath = path.join(__dirname, '..', 'candidates.json');
        fs.writeFileSync(outputPath, JSON.stringify(finalTokens, null, 2));
        console.log(`\n[+] Saved ${finalTokens.length} candidates to ${outputPath}`);
        
        const { sendMessage } = require('./telegram.cjs');
        if (finalTokens.length > 0) {
            let logMsg = `[+] Scraper found ${finalTokens.length} candidates:\n`;
            let tgMsg = `🔍 *GMGN Scraper Results: ${finalTokens.length} Tokens* 🔍\n━━━━━━━━━━━━━━━━━━\n`;
            finalTokens.forEach(t => {
                logMsg += `- ${t.symbol} (${t.address}) ST: ${t.latestSupertrend || 'N/A'}, Vol: ${t.volumeTrend || 'N/A'}\n`;
                
                const cleanName = t.name ? t.name.replace(/[_*`\[\]]/g, '') : 'Unknown';
                const cleanSymbol = t.symbol ? t.symbol.replace(/[_*`\[\]]/g, '') : 'Unknown';
                
                tgMsg += `💎 *${cleanName}* (${cleanSymbol})\n`;
                tgMsg += `🔗 \`${t.address}\`\n`;
                tgMsg += `💰 *MCap:* $${(t.market_cap / 1000).toFixed(1)}k | 👥 *Holders:* ${t.holder_count}\n`;
                
                let statsStr = `📈 *Vol:* $${(t.volume / 1000).toFixed(1)}k`;
                if (t.latestSupertrend !== undefined) statsStr += ` | 📊 *ST:* ${Number(t.latestSupertrend).toFixed(6)}`;
                if (t.volumeTrend !== undefined) statsStr += ` | 🌊 *Vol Trend:* ${t.volumeTrend} (${t.volumeChangePercent.toFixed(1)}%)`;
                if (t.is_new_ath) statsStr += `\n🚀 *STATUS: NEW ATH DETECTED*`;
                tgMsg += `${statsStr}\n`;
                
                let reasonStr = `Lolos filter: MCap > $${localFilters.minMarketCap/1000}k & Vol > $${localFilters.minVolume24h/1000}k`;
                if (techFilters.supertrend?.enabled) reasonStr += `, Supertrend Hijau`;
                if (techFilters.volumeTrend?.enabled) reasonStr += `, Vol Trend tidak Decelerating`;
                tgMsg += `💡 *Reason:* _${reasonStr}_\n\n`;
            });
            console.log(logMsg);
            sendMessage(tgMsg);
        } else {
            console.log(`[+] No candidates passed the filters.`);
            sendMessage(`🔍 *Scraper Run Finished:*\nNo candidates passed the filters.`);
        }
    } catch (e) {
        if (e.stdout) {
            console.error(`API Execution failed: ${e.stdout.trim()}`);
        } else {
            console.error(`Execution failed: ${e.message}`);
        }
    }
}

// Allow importing or running directly
if (require.main === module) {
    runScraper();
} else {
    module.exports = { runScraper };
}
