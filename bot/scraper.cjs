const { exec } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const execAsync = util.promisify(exec);

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
let apiFiltersStr = '';
if (apiSettings.apiFilters && Array.isArray(apiSettings.apiFilters)) {
    apiSettings.apiFilters.forEach(filter => {
        apiFiltersStr += ` --filter ${filter}`;
    });
}

const apiKey = process.env.GMGN_API_KEY || 'gmgn_solbscbaseethmonadtron';
const fetchTrendingCommand = `GMGN_API_KEY=${apiKey} npx gmgn-cli market trending --chain ${apiSettings.chain} --interval ${apiSettings.interval} --platform ${apiSettings.platform} --limit ${apiSettings.limit}${apiFiltersStr} --raw`;

async function fetchKlineData(address, timeframe) {
    const cmd = `GMGN_API_KEY=${apiKey} npx gmgn-cli market kline --chain ${apiSettings.chain} --address ${address} --resolution ${timeframe} --raw`;
    try {
        const { stdout } = await execAsync(cmd, { maxBuffer: 1024 * 1024 * 10 });
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
        const { stdout } = await execAsync(fetchTrendingCommand, { maxBuffer: 1024 * 1024 * 10 });
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
        if (techFilters.supertrend && techFilters.supertrend.enabled) {
            const stConf = techFilters.supertrend;
            for (let i = 0; i < fundamentalFilteredTokens.length; i++) {
                const token = fundamentalFilteredTokens[i];
                process.stdout.write(`[${i+1}/${fundamentalFilteredTokens.length}] Checking chart for ${token.symbol}... `);
                
                const klines = await fetchKlineData(token.address, stConf.timeframe);
                if (!klines || klines.length === 0) {
                    console.log(`Failed to fetch K-Line data.`);
                    continue;
                }

                const sortedKlines = klines.sort((a, b) => a.time - b.time).map(k => ({
                    open: parseFloat(k.open),
                    high: parseFloat(k.high),
                    low: parseFloat(k.low),
                    close: parseFloat(k.close)
                }));

                const result = calculateSupertrend(sortedKlines, stConf.period, stConf.multiplier);
                if (!result || result.trend.length === 0) {
                    console.log(`Not enough data for Supertrend.`);
                    continue;
                }

                const latestTrend = result.trend[result.trend.length - 1];
                const latestSupertrend = result.supertrend[result.supertrend.length - 1];
                const latestPrice = sortedKlines[sortedKlines.length - 1].close;

                if (latestTrend === 1) {
                    console.log(`PASS (Green Supertrend) - Price: $${latestPrice}, ST: $${latestSupertrend}`);
                    token.latestSupertrend = latestSupertrend;
                    token.latestPrice = latestPrice;
                    finalTokens.push(token);
                } else {
                    console.log(`FAIL (Red Supertrend) - Price: $${latestPrice}, ST: $${latestSupertrend}`);
                }
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
                logMsg += `- ${t.symbol} (${t.address}) ST: ${t.latestSupertrend}\n`;
                tgMsg += `💎 *${t.name}* (${t.symbol})\n`;
                tgMsg += `🔗 \`${t.address}\`\n`;
                tgMsg += `💰 *MCap:* $${(t.market_cap / 1000).toFixed(1)}k | 👥 *Holders:* ${t.holder_count}\n`;
                tgMsg += `📈 *Vol:* $${(t.volume / 1000).toFixed(1)}k | 📊 *ST:* ${Number(t.latestSupertrend).toFixed(6)}\n`;
                let reasonStr = `Lolos filter: MCap > $${localFilters.minMarketCap/1000}k & Vol > $${localFilters.minVolume24h/1000}k, Supertrend Hijau`;
                tgMsg += `💡 *Reason:* _${reasonStr}_\n\n`;
            });
            console.log(logMsg);
            sendMessage(tgMsg);
        } else {
            console.log(`[+] No candidates passed the filters.`);
            sendMessage(`🔍 *Scraper Run Finished:*\nNo candidates passed the filters.`);
        }
    } catch (e) {
        console.error("Execution failed.", e);
    }
}

// Allow importing or running directly
if (require.main === module) {
    runScraper();
} else {
    module.exports = { runScraper };
}
