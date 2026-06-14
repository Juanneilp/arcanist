const fs = require('fs');
const path = require('path');
const { exec, execFile } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);
const execFileAsync = util.promisify(execFile);
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
    const tpPercentage = exitConf.tpPercentage !== undefined ? exitConf.tpPercentage : 50;
    const slPercentage = exitConf.slPercentage !== undefined ? exitConf.slPercentage : 20;
    const maxHoldHours = exitConf.maxHoldHours !== undefined ? exitConf.maxHoldHours : 24;
    const rsiConf = exitConf.rsi || { period: 2, upperLimit: 90 };
    const bbConf = exitConf.bb || { period: 20, multiplier: 2 };
    const macdConf = exitConf.macd || { fast: 12, slow: 26, signal: 9 };
    
    const apiKey = process.env.GMGN_API_KEY || 'gmgn_solbscbaseethmonadtron';
    const chain = userConfig.apiSettings?.chain || 'sol';
    // Only need ~100 candles for MACD(26) to stabilize. 100 * 15m = 25 hours. We fetch last 48 hours to be safe.
    const fromTimestamp = Math.floor(Date.now() / 1000) - (48 * 60 * 60);
    
    try {
        const { stdout } = await execFileAsync('npx', [
            'gmgn-cli', 'market', 'kline', 
            '--chain', chain, 
            '--address', position.tokenMint, 
            '--resolution', '15m', 
            '--from', fromTimestamp.toString(), 
            '--raw'
        ], {
            env: { ...process.env, GMGN_API_KEY: apiKey },
            maxBuffer: 1024 * 1024 * 10
        });
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
        
        // Timeout check
        const durationHours = (Date.now() - position.timestamp) / 3600000;
        if (maxHoldHours > 0 && durationHours >= maxHoldHours) {
            console.log(`[EXIT SIGNAL] ${position.tokenSymbol}: Timeout hit (${durationHours.toFixed(2)}h >= ${maxHoldHours}h)`);
            return true;
        }

        // PnL check
        if (position.entryPriceUsd) {
            const pnlPercentage = ((currentClose - position.entryPriceUsd) / position.entryPriceUsd) * 100;
            if (tpPercentage > 0 && pnlPercentage >= tpPercentage) {
                console.log(`[EXIT SIGNAL] ${position.tokenSymbol}: Take Profit hit (+${pnlPercentage.toFixed(2)}% >= ${tpPercentage}%)`);
                return true;
            }
            if (slPercentage > 0 && pnlPercentage <= -slPercentage) {
                console.log(`[EXIT SIGNAL] ${position.tokenSymbol}: Stop Loss hit (${pnlPercentage.toFixed(2)}% <= -${slPercentage}%)`);
                return true;
            }
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
    const closeMode = userConfig.monitoringConfig?.closeMode || "auto";
    
    const activePositions = readState();
    if (activePositions.length === 0) return;
    
    if (closeMode === "manual") {
        return;
    }
    
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

async function processCandidates(autoEntry, maxPositions, botConfig, connection, walletKeypair, botMode) {
    if (!autoEntry) {
        console.log("Auto Entry is disabled. Skipping candidate processing.");
        return;
    }

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
            
            let aiMsg = `🤖 *Hermes AI Selection (Top ${candidates.length})* 🤖\n━━━━━━━━━━━━━━━━━━\n`;
            candidates.forEach((t, index) => {
                const rankEmoji = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '💎';
                aiMsg += `${rankEmoji} *${t.name}* (${t.symbol})\n`;
                aiMsg += `🔗 \`${t.address}\`\n`;
                aiMsg += `💰 *MCap:* $${(t.market_cap / 1000).toFixed(1)}k | 👥 *Holders:* ${t.holder_count}\n`;
                aiMsg += `📈 *Vol:* $${(t.volume / 1000).toFixed(1)}k | 🧠 *Degens:* ${t.smart_degen_count}\n`;
                if (t.ai_reason) aiMsg += `💡 *Reason:* _${t.ai_reason}_\n`;
                aiMsg += `━━━━━━━━━━━━━━━━━━\n`;
            });
            sendMessage(aiMsg);
            
            for (const token of candidates) {
                console.log(`\n==================================================`);
                console.log(`Processing Token: ${token.symbol} (${token.address})`);
                
                let solToDeploy = 0;
                try {
                    let walletBalanceUi = 0;
                    if (botMode === 'dry_run' && (!process.env.WALLET_PRIVATE_KEY || process.env.WALLET_PRIVATE_KEY === 'your_wallet_private_key_base58')) {
                        walletBalanceUi = 5.0; 
                    } else {
                        walletBalanceUi = (await connection.getBalance(walletKeypair.publicKey)) / 1e9;
                    }

                    const maxSolPerPosition = botConfig.maxSolPerPosition || 0.15;
                    const minSolToOpen = botConfig.minSolToOpen || 0.21;
                    const gasReserve = botConfig.gasReserve || 0.1;
                    const refundableReserve = botConfig.refundableReserve || 0.05;

                    if (walletBalanceUi < minSolToOpen) {
                        console.log(`[Skip] Wallet balance (${walletBalanceUi.toFixed(4)} SOL) is below minSolToOpen (${minSolToOpen} SOL).`);
                        continue;
                    }

                    const availableBalance = Math.max(0, walletBalanceUi - gasReserve - refundableReserve);
                    solToDeploy = Math.min(availableBalance, maxSolPerPosition);

                    if (solToDeploy <= 0) {
                        console.log(`[Skip] Insufficient balance for deployment after gas and refundable reserves.`);
                        continue;
                    }

                    const pools = await fetchMeteoraPools(token.address, WSOL_MINT);
                    const filteredPools = pools.filter(p => p.bin_step >= botConfig.minBinStep && p.bin_step <= botConfig.maxBinStep);
                    
                    if (filteredPools.length === 0) {
                        console.warn(`No matching Meteora pool found for ${token.symbol}/SOL with bin steps between ${botConfig.minBinStep} and ${botConfig.maxBinStep}.`);
                        continue;
                    }
                    
                    const targetPool = filteredPools.sort((a, b) => b.liquidity - a.liquidity)[0];
                    const solLamportsToLP = Math.floor(solToDeploy * 1e9);
                    
                    console.log(`[${botMode.toUpperCase()}] Adding Single-Sided SOL Liquidity to ${targetPool.address} (Bin Step: ${targetPool.bin_step})...`);
                    const result = await addLiquidity(connection, walletKeypair, targetPool.address, WSOL_MINT, solLamportsToLP, botConfig.minRange, botConfig.maxRange, { type: botConfig.strategyType }, botMode);
                    
                    if (botMode === "dry_run") {
                        sendMessage(`ℹ️ *DRY RUN: Entry Skipped*\nToken: ${token.symbol}\nPool: \`${targetPool.address}\``);
                        continue;
                    }
                    
                    let entryPriceUsd = null;
                    try {
                        const { fetchWithRetry } = require('./api-utils.cjs');
                        const res = await fetchWithRetry(`https://price.jup.ag/v6/price?ids=${token.address}`);
                        if (res.ok) {
                            const data = await res.json();
                            if (data.data && data.data[token.address]) {
                                entryPriceUsd = data.data[token.address].price;
                            }
                        }
                    } catch (e) {
                        console.error(`Failed to fetch Jupiter price for ${token.symbol}:`, e.message);
                    }
                    
                    const newPos = {
                        positionPubKey: result.positionPubKey,
                        poolAddress: targetPool.address,
                        tokenMint: token.address,
                        tokenSymbol: token.symbol,
                        openedBy: "auto",
                        investedSol: solToDeploy,
                        entryBinPrice: result.activeBinPrice,
                        entryPriceUsd: entryPriceUsd
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
    
    if (!process.env.RPC_URL) {
        console.error("Missing RPC_URL in .env");
        process.exit(1);
    }

    const connection = new Connection(process.env.RPC_URL, 'confirmed');
    let walletKeypair;

    if (botMode === 'dry_run') {
        try {
            if (process.env.WALLET_PRIVATE_KEY && process.env.WALLET_PRIVATE_KEY !== 'your_wallet_private_key_base58') {
                const decodedKey = bs58.decode(process.env.WALLET_PRIVATE_KEY);
                walletKeypair = Keypair.fromSecretKey(decodedKey);
            } else {
                walletKeypair = Keypair.generate();
                console.warn(`[DRY RUN] WALLET_PRIVATE_KEY is missing/default. Using dummy wallet: ${walletKeypair.publicKey.toString()}`);
            }
        } catch (e) {
            walletKeypair = Keypair.generate();
            console.warn(`[DRY RUN] Invalid WALLET_PRIVATE_KEY format. Using dummy wallet: ${walletKeypair.publicKey.toString()}`);
        }
    } else {
        if (!process.env.WALLET_PRIVATE_KEY || process.env.WALLET_PRIVATE_KEY === 'your_wallet_private_key_base58') {
            console.error("Missing WALLET_PRIVATE_KEY in .env");
            process.exit(1);
        }
        try {
            const decodedKey = bs58.decode(process.env.WALLET_PRIVATE_KEY);
            walletKeypair = Keypair.fromSecretKey(decodedKey);
            console.log(`Wallet loaded: ${walletKeypair.publicKey.toString()}`);
        } catch (e) {
            console.error("Failed to load wallet. Check WALLET_PRIVATE_KEY format.");
            process.exit(1);
        }
    }

    const botConfig = userConfig.meteoraConfig || { maxSolPerPosition: 0.15, minSolToOpen: 0.21, gasReserve: 0.1, refundableReserve: 0.05, minBinStep: 80, maxBinStep: 125, minRange: 86, maxRange: 94, strategyType: 0 };
    const entryMode = userConfig.monitoringConfig?.entryMode || "auto";
    const autoEntry = entryMode === "auto";
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
            
            // Process the newly scraped candidates immediately
            await processCandidates(autoEntry, currentMaxPositions, botConfig, connection, walletKeypair, botMode);
        } catch (e) {
            console.error('[Scraper] Error in cron job:', e);
        } finally {
            isScraperRunning = false;
        }
    });
    console.log(`Started Scraper Cron Job (Interval: ${scraperIntervalMinutes}m)`);

    // --- Initial Entry Logic (Startup) ---
    await processCandidates(autoEntry, maxPositions, botConfig, connection, walletKeypair, botMode);
}

runBot();
