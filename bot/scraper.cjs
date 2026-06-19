const { spawn } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');
const { spawnAsync } = require('./api-utils.cjs');

require('./envcrypt.cjs').loadEnv();


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
let config, apiSettings, localFilters, techFilters, blacklist;
function loadConfig() {
    try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        apiSettings = config.apiSettings;
        localFilters = config.localFilters;
        techFilters = config.technicalFilters || {};
    } catch (error) {
        console.error("Failed to read user-config.json.");
        if (!config) process.exit(1);
    }
    const blacklistPath = path.join(__dirname, '..', 'blacklist.json');
    try {
        if (fs.existsSync(blacklistPath)) {
            blacklist = JSON.parse(fs.readFileSync(blacklistPath, 'utf-8'));
        } else {
            blacklist = [];
        }
    } catch (error) {
        console.error("Failed to read blacklist.json.");
        blacklist = [];
    }
}
loadConfig();

console.log(`Starting GMGN Scraper...`);

const apiKey = process.env.GMGN_API_KEY || 'gmgn_solbscbaseethmonadtron';

async function fetchKlineData(address, timeframe) {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) && !/^0x[a-fA-F0-9]{40}$/.test(address)) {
        console.error(`[Security] Invalid address format detected: ${address}`);
        return null;
    }
    try {
        const { stdout } = await spawnAsync('npx', [
            'gmgn-cli', 'market', 'kline',
            '--chain', apiSettings.chain,
            '--address', address,
            '--resolution', timeframe,
            '--raw'
        ], {
            env: { ...process.env, GMGN_API_KEY: apiKey }
        });
        const response = JSON.parse(stdout);
        if (response.list) return response.list;
        return null;
    } catch (e) {
        return null;
    }
}

async function runScraper() {
    loadConfig();
    console.log(`Executing API Request for Trending Tokens...`);
    try {
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

        const { stdout } = await spawnAsync('npx', args, {
            env: { ...process.env, GMGN_API_KEY: apiKey }
        });
        const response = JSON.parse(stdout);
        if (response.code !== 0) return console.error(`API Error: ${response.msg}`);

        const tokens = response.data.rank || [];
        const fundamentalFilteredTokens = tokens.filter(token => {
            if (blacklist && blacklist.some(b => (typeof b === 'string' ? b : b.address) === token.address)) return false;
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

            const top10Percentage = (parseFloat(token.top_10_holder_rate) || 0) * 100;
            const devHoldsPercentage = (parseFloat(token.dev_team_hold_rate) || 0) * 100;
            const insiderPercentage = (parseFloat(token.rat_trader_amount_rate) || 0) * 100;
            const phishingPercentage = (parseFloat(token.entrapment_ratio) || 0) * 100;
            const bundlingPercentage = (parseFloat(token.bundler_rate) || 0) * 100;
            const rugPercentage = (parseFloat(token.rug_ratio) || 0) * 100;
            const isLiquidityBurnt = token.burn_status === "burn" || parseFloat(token.burn_ratio) >= 1;

            let passAdvancedFilters = true;
            
            const athMcap = parseFloat(token.history_highest_market_cap) || 0;
            let athDropPercentage = 0;
            if (athMcap > 0) {
                athDropPercentage = ((athMcap - marketCap) / athMcap) * 100;
            }
            if (localFilters.maxAthDropPercentage !== undefined && athDropPercentage > localFilters.maxAthDropPercentage) passAdvancedFilters = false;

            if (localFilters.maxTop10Percentage !== undefined && top10Percentage > localFilters.maxTop10Percentage) passAdvancedFilters = false;
            if (localFilters.maxDevHoldsPercentage !== undefined && devHoldsPercentage > localFilters.maxDevHoldsPercentage) passAdvancedFilters = false;
            if (localFilters.maxInsiderPercentage !== undefined && insiderPercentage > localFilters.maxInsiderPercentage) passAdvancedFilters = false;
            if (localFilters.maxPhishingPercentage !== undefined && phishingPercentage > localFilters.maxPhishingPercentage) passAdvancedFilters = false;
            if (localFilters.maxBundlingPercentage !== undefined && bundlingPercentage > localFilters.maxBundlingPercentage) passAdvancedFilters = false;
            if (localFilters.maxRugPercentage !== undefined && rugPercentage > localFilters.maxRugPercentage) passAdvancedFilters = false;
            if (localFilters.requireLiquidityBurnt === true && !isLiquidityBurnt) passAdvancedFilters = false;

            return marketCap >= localFilters.minMarketCap && 
                   volume24h >= localFilters.minVolume24h &&
                   gasFee >= localFilters.minTotalFees &&
                   smartDegenCount >= localFilters.minSmartDegenCount &&
                   holderCount >= localFilters.minHolders &&
                   ageInHours >= (localFilters.minTokenAgeHours || 0) &&
                   passAdvancedFilters;
        });

        const finalTokens = [];
        const stConf = techFilters.supertrend || { enabled: false };
        const vtConf = techFilters.volumeTrend || { enabled: false };

        if (stConf.enabled || vtConf.enabled) {
            const timeframe = stConf.enabled ? stConf.timeframe : "15m";
            for (let i = 0; i < fundamentalFilteredTokens.length; i++) {
                const token = fundamentalFilteredTokens[i];
                process.stdout.write(`[${i+1}/${fundamentalFilteredTokens.length}] Checking chart for ${token.symbol}... `);
                
                // Add a 1.5 second delay between requests to prevent GMGN "Too Many Requests" (Rate Limit)
                if (i > 0) {
                    await new Promise(resolve => setTimeout(resolve, 1500));
                }
                
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

                const volStr = vtConf.enabled ? `Vol ${volumeTrendStatus}` : '';
                console.log(`PASS (ST Hijau${volStr ? ', ' + volStr : ''}) - Price: $${latestPrice}`);
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
                const volInfo = t.volumeTrend ? `, Vol: ${t.volumeTrend}` : '';
                logMsg += `- ${t.symbol} (${t.address}) ST: ${t.latestSupertrend || 'N/A'}${volInfo}\n`;
                
                const cleanName = t.name ? t.name.replace(/[_*`\[\]]/g, '') : 'Unknown';
                const cleanSymbol = t.symbol ? t.symbol.replace(/[_*`\[\]]/g, '') : 'Unknown';
                
                tgMsg += `💎 *${cleanName}* (${cleanSymbol})\n`;
                tgMsg += `🔗 \`${t.address}\`\n`;
                
                const tMcap = parseFloat(t.market_cap) || 0;
                const tAthMcap = parseFloat(t.history_highest_market_cap) || 0;
                let tAthDrop = 0;
                if (tAthMcap > 0) tAthDrop = ((tAthMcap - tMcap) / tAthMcap) * 100;
                const tPrice = parseFloat(t.price) || t.latestPrice || 0;
                const tAthPrice = parseFloat(t.history_highest_price) || 0;

                tgMsg += `💰 *MCap:* $${(tMcap / 1000).toFixed(1)}k | 👑 *ATH MCap:* $${(tAthMcap / 1000).toFixed(1)}k (🔻-${tAthDrop.toFixed(1)}%)\n`;
                if (tAthPrice > 0) {
                    tgMsg += `💲 *Price:* $${tPrice.toFixed(6)} | 👑 *ATH Price:* $${tAthPrice.toFixed(6)}\n`;
                } else {
                    tgMsg += `💲 *Price:* $${tPrice.toFixed(6)}\n`;
                }
                tgMsg += `👥 *Holders:* ${t.holder_count}\n`;
                
                let statsStr = `📈 *Vol:* $${(t.volume / 1000).toFixed(1)}k | 🧠 *Degens:* ${t.smart_degen_count || 0}`;
                if (t.latestSupertrend !== undefined) statsStr += ` | 📊 *ST:* ${Number(t.latestSupertrend).toFixed(6)}`;
                if (t.volumeTrend !== undefined) statsStr += ` | 🌊 *Vol Trend:* ${t.volumeTrend} (${t.volumeChangePercent.toFixed(1)}%)`;
                if (t.is_new_ath) statsStr += `\n🚀 *STATUS: NEW ATH DETECTED*`;
                tgMsg += `${statsStr}\n`;
                
                let reasonStr = `Lolos filter: MCap > $${localFilters.minMarketCap/1000}k & Vol > $${localFilters.minVolume24h/1000}k & Degens >= ${localFilters.minSmartDegenCount} & Advanced Security Filters`;
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
