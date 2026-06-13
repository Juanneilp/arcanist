const { exec } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');
const { calculateSupertrend } = require('./supertrend.cjs');

// Load environment variables from .env file
require('dotenv').config();

const execAsync = util.promisify(exec);

// Load User Config
const configPath = path.join(__dirname, 'user-config.json');
let config;
try {
    const rawConfig = fs.readFileSync(configPath, 'utf-8');
    config = JSON.parse(rawConfig);
} catch (error) {
    console.error("Failed to read or parse user-config.json. Make sure the file exists and is valid JSON.");
    process.exit(1);
}

const apiSettings = config.apiSettings;
const localFilters = config.localFilters;
const techFilters = config.technicalFilters || {};

console.log(`Starting GMGN Scraper...`);
console.log(`Using Configuration from user-config.json\n`);

let apiFiltersStr = '';
if (apiSettings.apiFilters && Array.isArray(apiSettings.apiFilters)) {
    apiSettings.apiFilters.forEach(filter => {
        apiFiltersStr += ` --filter ${filter}`;
    });
}

if (!process.env.GMGN_API_KEY) {
    console.warn("WARNING: GMGN_API_KEY is not defined in your environment or .env file.");
    console.warn("Falling back to the public demo API key ('gmgn_solbscbaseethmonadtron'). Rate limits may apply.\n");
}

const apiKey = process.env.GMGN_API_KEY || 'gmgn_solbscbaseethmonadtron';
const fetchTrendingCommand = `GMGN_API_KEY=${apiKey} npx gmgn-cli market trending --chain ${apiSettings.chain} --interval ${apiSettings.interval} --platform ${apiSettings.platform} --limit ${apiSettings.limit}${apiFiltersStr} --raw`;

async function fetchKlineData(address, timeframe) {
    const cmd = `GMGN_API_KEY=${apiKey} npx gmgn-cli market kline --chain ${apiSettings.chain} --address ${address} --resolution ${timeframe} --raw`;
    try {
        const { stdout } = await execAsync(cmd, { maxBuffer: 1024 * 1024 * 10 });
        const response = JSON.parse(stdout);
        if (response.list) {
            return response.list;
        }
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
        
        if (response.code !== 0) {
            console.error(`API Error: ${response.msg}`);
            return;
        }

        const tokens = response.data.rank || [];
        console.log(`Fetched ${tokens.length} trending tokens from the API. Applying strict local fundamental filters...`);

        const fundamentalFilteredTokens = tokens.filter(token => {
            const marketCap = parseFloat(token.market_cap) || 0;
            const volume24h = parseFloat(token.volume) || 0; 
            const gasFee = parseFloat(token.gas_fee) || 0; 
            const smartDegenCount = parseInt(token.smart_degen_count, 10) || 0;
            const holderCount = parseInt(token.holder_count, 10) || 0;
            const creationTimestamp = parseInt(token.creation_timestamp, 10) || parseInt(token.open_timestamp, 10) || 0;
            
            let ageInHours = 0;
            if (creationTimestamp > 0) {
                const nowUnix = Math.floor(Date.now() / 1000);
                ageInHours = (nowUnix - creationTimestamp) / 3600;
            }

            const minTokenAgeHours = localFilters.minTokenAgeHours || 0;

            return marketCap >= localFilters.minMarketCap && 
                   volume24h >= localFilters.minVolume24h &&
                   gasFee >= localFilters.minTotalFees &&
                   smartDegenCount >= localFilters.minSmartDegenCount &&
                   holderCount >= localFilters.minHolders &&
                   ageInHours >= minTokenAgeHours;
        });

        console.log(`Found ${fundamentalFilteredTokens.length} tokens matching fundamental criteria.\n`);

        const finalTokens = [];

        if (techFilters.supertrend && techFilters.supertrend.enabled) {
            const stConf = techFilters.supertrend;
            console.log(`Running Technical Analysis (Supertrend ${stConf.timeframe}, Period: ${stConf.period}, Mult: ${stConf.multiplier})...`);
            
            for (let i = 0; i < fundamentalFilteredTokens.length; i++) {
                const token = fundamentalFilteredTokens[i];
                process.stdout.write(`[${i+1}/${fundamentalFilteredTokens.length}] Checking chart for ${token.symbol}... `);
                
                const klines = await fetchKlineData(token.address, stConf.timeframe);
                if (!klines || klines.length === 0) {
                    console.log(`Failed to fetch K-Line data.`);
                    continue;
                }

                // Format K-line data
                const formattedData = klines.map(k => ({
                    open: parseFloat(k.open),
                    high: parseFloat(k.high),
                    low: parseFloat(k.low),
                    close: parseFloat(k.close)
                })).reverse(); // Reverse if API returns newest first, wait! 
                
                // Let's verify sort order. GMGN API usually returns oldest first or newest first.
                // We'll sort by time just to be absolutely sure.
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
            // Supertrend disabled, use all filtered tokens
            finalTokens.push(...fundamentalFilteredTokens);
        }

        console.log(`\n==================================================`);
        console.log(`Found ${finalTokens.length} tokens matching ALL Fundamental and Technical criteria:\n`);

        finalTokens.forEach((token, index) => {
            console.log(`[${index + 1}] ${token.symbol} (${token.name})`);
            console.log(`    Address:       ${token.address}`);
            console.log(`    Market Cap:    $${Number(token.market_cap).toLocaleString()}`);
            console.log(`    Volume 24H:    $${Number(token.volume).toLocaleString()}`);
            console.log(`    Holders:       ${token.holder_count}`);
            if (token.latestSupertrend) {
                console.log(`    Current Price: $${token.latestPrice}`);
                console.log(`    Supertrend:    $${token.latestSupertrend} (GREEN/BULLISH)`);
            }
            console.log(`--------------------------------------------------`);
        });

    } catch (e) {
        console.error("Execution failed.");
        console.error(e);
    }
}

runScraper();
