const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);
const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58');
const { fetchMeteoraPools, addLiquidity, removeLiquidity, swapTokenToSol } = require('./solana-dex.cjs');
const { readState, addPosition, removePosition, logTrade } = require('./state.cjs');
const { screenCandidates } = require('./ai-agent.cjs');
const { sendMessage } = require('./telegram.cjs');
const { calculateRSI, calculateMACD, calculateBollingerBands } = require('./indicators.cjs');
const cron = require('node-cron');
const { runScraper } = require('./scraper.cjs');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

async function getTokenBalance(connection, walletPubKey, tokenMintStr) {
    try {
        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(walletPubKey, {
            mint: new PublicKey(tokenMintStr)
        });
        if (tokenAccounts.value.length > 0) {
            return tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount;
        }
    } catch (e) {
        console.error("Error fetching token balance:", e);
    }
    return 0;
}

// Evaluate exit using GMGN Chart and Indicators
async function evaluateExitCondition(position) {
    const configPath = path.join(__dirname, '..', 'user-config.json');
    let userConfig;
    try {
        userConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (e) {
        return false;
    }
    
    const exitConf = userConfig.exitConfig || {};
    const rsiConf = exitConf.rsi || { period: 2, upperLimit: 90 };
    const bbConf = exitConf.bb || { period: 20, multiplier: 2 };
    const macdConf = exitConf.macd || { fast: 12, slow: 26, signal: 9 };
    
    const apiKey = process.env.GMGN_API_KEY || 'gmgn_solbscbaseethmonadtron';
    const chain = userConfig.apiSettings?.chain || 'sol';
    const cmd = `GMGN_API_KEY=${apiKey} npx gmgn-cli market kline --chain ${chain} --address ${position.tokenMint} --resolution 15m --raw`;
    
    try {
        const { stdout } = await execAsync(cmd, { maxBuffer: 1024 * 1024 * 10 });
        const response = JSON.parse(stdout);
        
        if (!response.list || response.list.length < Math.max(rsiConf.period, bbConf.period, macdConf.slow) + 10) {
            console.log(`Not enough kline data to evaluate exit for ${position.tokenSymbol}.`);
            return false;
        }
        
        const sortedKlines = response.list.sort((a, b) => a.time - b.time);
        const closes = sortedKlines.map(k => parseFloat(k.close));
        
        const rsiArr = calculateRSI(closes, rsiConf.period);
        const bb = calculateBollingerBands(closes, bbConf.period, bbConf.multiplier);
        const macd = calculateMACD(closes, macdConf.fast, macdConf.slow, macdConf.signal);
        
        const lastIdx = closes.length - 1;
        const currentClose = closes[lastIdx];
        const currentRsi = rsiArr[lastIdx];
        const currentBbUpper = bb.upper[lastIdx];
        const currentMacdHist = macd.histogram[lastIdx];
        const prevMacdHist = macd.histogram[lastIdx - 1];
        
        if (currentRsi === null || currentBbUpper === null || currentMacdHist === null || prevMacdHist === null) {
            return false;
        }
        
        const rsiConditionMet = currentRsi > rsiConf.upperLimit;
        const priceAboveBbUpper = currentClose > currentBbUpper;
        const macdFirstGreenHist = prevMacdHist <= 0 && currentMacdHist > 0;
        
        if (rsiConditionMet && priceAboveBbUpper) {
            console.log(`[EXIT SIGNAL] ${position.tokenSymbol}: RSI(${rsiConf.period})=${currentRsi.toFixed(2)} > ${rsiConf.upperLimit} AND Close > BB Upper`);
            return true;
        }
        
        if (rsiConditionMet && macdFirstGreenHist) {
            console.log(`[EXIT SIGNAL] ${position.tokenSymbol}: RSI(${rsiConf.period})=${currentRsi.toFixed(2)} > ${rsiConf.upperLimit} AND MACD First Green Histogram`);
            return true;
        }
        
    } catch (e) {
        console.error(`Error checking exit conditions for ${position.tokenSymbol}:`, e.message);
    }
    
    return false;
}

async function monitoringLoop(connection, walletKeypair) {
    const configPath = path.join(__dirname, '..', 'user-config.json');
    let userConfig;
    try {
        userConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (e) {
        return;
    }
    
    const botMode = userConfig.botMode || "dry_run";
    
    const activePositions = readState();
    if (activePositions.length === 0) return;
    
    console.log(`[Monitor] Checking ${activePositions.length} active positions...`);
    
    for (const pos of activePositions) {
        const shouldExit = await evaluateExitCondition(pos);
        if (shouldExit) {
            console.log(`[Monitor] Exit condition met for position ${pos.positionPubKey}.`);
            sendMessage(`🚨 *Closing Position* 🚨\nToken: ${pos.tokenSymbol}\nReason: Exit Condition Met`);
            
            try {
                // 1. Remove Liquidity
                await removeLiquidity(connection, walletKeypair, pos.poolAddress, pos.positionPubKey, botMode);
                sendMessage(`✅ Liquidity Removed for ${pos.tokenSymbol}`);
                
                // 2. Remove from active state
                removePosition(pos.positionPubKey);
                
                // 3. Dust Sweeper
                let reclaimedSol = 0;
                const balanceUi = await getTokenBalance(connection, walletKeypair.publicKey, pos.tokenMint);
                if (balanceUi > 0) {
                    sendMessage(`🧹 Dust Sweeping: Found ${balanceUi} ${pos.tokenSymbol}`);
                    const swapResult = await swapTokenToSol(connection, walletKeypair, pos.tokenMint, balanceUi, botMode);
                    if (!swapResult.skipped) {
                        reclaimedSol = swapResult.expectedSolOut;
                        sendMessage(`✅ Swap Success! Reclaimed ~${swapResult.expectedSolOut.toFixed(4)} SOL`);
                    } else {
                        sendMessage(`ℹ️ Dust value too low (~$${swapResult.usdValue.toFixed(2)}). Skipped swap.`);
                    }
                }
                
                logTrade('EXIT', {
                    ...pos,
                    reason: "Exit Condition Met",
                    reclaimedSol
                });
            } catch (e) {
                console.error(`Error closing position ${pos.positionPubKey}:`, e);
                sendMessage(`❌ *Error Closing Position* ${pos.tokenSymbol}: ${e.message}`);
            }
        }
    }
}

async function runBot() {
    const configPath = path.join(__dirname, '..', 'user-config.json');
    if (!fs.existsSync(configPath)) {
        console.error("user-config.json not found!");
        process.exit(1);
    }
    const userConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const botMode = userConfig.botMode || "dry_run";

    console.log(`Starting Arcanist DLMM Bot in ${botMode.toUpperCase()} mode...`);
    sendMessage(`🚀 *Arcanist DLMM Bot Started*\nMode: *${botMode.toUpperCase()}*`);
    
    if (!process.env.WALLET_PRIVATE_KEY || !process.env.RPC_URL) {
        console.error("Missing WALLET_PRIVATE_KEY or RPC_URL in .env");
        process.exit(1);
    }

    const connection = new Connection(process.env.RPC_URL, 'confirmed');
    let walletKeypair;
    try {
        const decodedKey = bs58.decode(process.env.WALLET_PRIVATE_KEY);
        walletKeypair = Keypair.fromSecretKey(decodedKey);
        console.log(`Wallet loaded: ${walletKeypair.publicKey.toString()}`);
    } catch (e) {
        console.error("Failed to load wallet. Check WALLET_PRIVATE_KEY format.");
        process.exit(1);
    }

    const botConfig = userConfig.meteoraConfig || { solAmountToLP: 0.01, minBinStep: 80, maxBinStep: 125, minRange: 86, maxRange: 94, strategyType: 0 };
    const autoEntry = userConfig.monitoringConfig?.autoEntryEnabled ?? true;
    const maxPositions = userConfig.monitoringConfig?.maxActivePositions || 2;

    // Start Monitoring Loop (For Exit Conditions)
    const checkInterval = (userConfig.monitoringConfig?.checkIntervalSeconds || 30) * 1000;
    setInterval(() => monitoringLoop(connection, walletKeypair), checkInterval);
    console.log(`Started Exit Monitoring Loop (Interval: ${checkInterval/1000}s)`);

    // --- Telegram Report Cron Job ---
    const reportIntervalMinutes = userConfig.monitoringConfig?.monitoringIntervalMinutes || 20;
    let reportCronExpression = `*/${reportIntervalMinutes} * * * *`;
    if (reportIntervalMinutes < 1) reportCronExpression = `* * * * *`;
    
    cron.schedule(reportCronExpression, () => {
        const currentActivePositions = readState();
        if (currentActivePositions.length === 0) {
            sendMessage(`ℹ️ *Status Report*\nCurrently 0 active positions.`);
        } else {
            let msg = `📊 *Status Report (${currentActivePositions.length} Active Positions)*\n\n`;
            currentActivePositions.forEach((pos, i) => {
                msg += `${i+1}. *${pos.tokenSymbol}*\n   Pool: \`${pos.poolAddress}\`\n   Invested: ${pos.investedSol} SOL\n\n`;
            });
            sendMessage(msg);
        }
    });
    console.log(`Started Telegram Report Cron Job (Interval: ${reportIntervalMinutes}m)`);

    // --- Scraper Cron Job ---
    const scraperIntervalMinutes = userConfig.monitoringConfig?.scraperIntervalMinutes || 5;
    let cronExpression = `*/${scraperIntervalMinutes} * * * *`;
    if (scraperIntervalMinutes < 1) cronExpression = `* * * * *`;
    
    let isScraperRunning = false;
    
    cron.schedule(cronExpression, async () => {
        if (isScraperRunning) {
            console.log(`[Scraper] Scraper is still running from a previous schedule. Skipping this run to prevent overlap.`);
            return;
        }
        
        try {
            isScraperRunning = true;
            const currentConfigPath = path.join(__dirname, '..', 'user-config.json');
            let currentConfig;
            try {
                currentConfig = JSON.parse(fs.readFileSync(currentConfigPath, 'utf-8'));
            } catch (e) {
                return;
            }
            
            const currentMaxPositions = currentConfig.monitoringConfig?.maxActivePositions || 2;
            const currentActivePositions = readState();
            
            if (currentActivePositions.length >= currentMaxPositions) {
                console.log(`[Scraper] Active positions (${currentActivePositions.length}) reached max limit (${currentMaxPositions}). Skipping scraper.`);
                return;
            }
            
            console.log(`[Scraper] Starting scheduled scrape (Cron: ${cronExpression})...`);
            await runScraper();
        } catch (e) {
            console.error('[Scraper] Error in cron job:', e);
        } finally {
            isScraperRunning = false;
        }
    });
    console.log(`Started Scraper Cron Job (Interval: ${scraperIntervalMinutes}m)`);

    // --- Entry Logic ---
    if (autoEntry) {
        const candidatesPath = path.join(__dirname, '..', 'candidates.json');
        if (fs.existsSync(candidatesPath)) {
            let candidates = JSON.parse(fs.readFileSync(candidatesPath, 'utf-8'));
            console.log(`Loaded ${candidates.length} candidate(s) from JSON.`);
            
            const activePositions = readState();
            const availableSlots = maxPositions - activePositions.length;
            
            if (availableSlots > 0 && candidates.length > 0) {
                sendMessage(`🔍 Found ${candidates.length} candidates. Requesting Hermes AI screening...`);
                // AI Screening
                candidates = await screenCandidates(candidates, availableSlots);
                sendMessage(`🤖 AI Selected ${candidates.length} candidates for entry.`);
                
                for (const token of candidates) {
                    console.log(`\n==================================================`);
                    console.log(`Processing Token: ${token.symbol} (${token.address})`);
                    
                    try {
                        const pools = await fetchMeteoraPools(token.address, WSOL_MINT);
                        const filteredPools = pools.filter(p => p.bin_step >= botConfig.minBinStep && p.bin_step <= botConfig.maxBinStep);
                        
                        if (filteredPools.length === 0) {
                            console.warn(`No matching Meteora pool found for ${token.symbol}/SOL with bin steps between ${botConfig.minBinStep} and ${botConfig.maxBinStep}.`);
                            continue;
                        }
                        
                        const targetPool = filteredPools.sort((a, b) => b.liquidity - a.liquidity)[0];
                        const solLamportsToLP = Math.floor(botConfig.solAmountToLP * 1e9);
                        
                        console.log(`[${botMode.toUpperCase()}] Adding Single-Sided SOL Liquidity to ${targetPool.address} (Bin Step: ${targetPool.bin_step})...`);
                        const result = await addLiquidity(connection, walletKeypair, targetPool.address, WSOL_MINT, solLamportsToLP, botConfig.minRange, botConfig.maxRange, { type: botConfig.strategyType }, botMode);
                        
                        const newPos = {
                            positionPubKey: result.positionPubKey,
                            poolAddress: targetPool.address,
                            tokenMint: token.address,
                            tokenSymbol: token.symbol,
                            openedBy: "auto",
                            investedSol: botConfig.solAmountToLP
                        };
                        
                        addPosition(newPos);
                        logTrade('ENTRY', newPos);
                        
                        sendMessage(`🟢 *Position Opened* 🟢\nToken: ${token.symbol}\nPool: \`${targetPool.address}\`\nPosition: \`${result.positionPubKey}\``);
                        
                    } catch (e) {
                        console.error(`Error processing ${token.symbol}:`, e.message);
                    }
                }
            } else {
                console.log("No available slots for new positions or no candidates.");
            }
        }
    } else {
        console.log("Auto Entry is disabled. Running monitor only.");
    }
}

runBot();
