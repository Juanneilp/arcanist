const fs = require('fs');
const path = require('path');
const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58').default || require('bs58');
const { fetchMeteoraPools, addLiquidity, syncManualPositions, fetchMeteoraPositionDetails } = require('./solana-dex.cjs');
const { readState, addPosition, removePosition } = require('./state.cjs');
const { screenCandidates } = require('./ai-agent.cjs');
const { sendMessage } = require('./telegram.cjs');
const cron = require('node-cron');
const { runScraper } = require('./scraper.cjs');
const { processCandidates } = require('./engine.cjs');
const { monitoringLoop } = require('./monitor.cjs');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err.message || err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection:', reason?.message || reason);
});


async function runBot() {
    const configPath = path.join(__dirname, '..', 'user-config.json');
    if (!fs.existsSync(configPath)) {
        console.error("user-config.json not found!");
        process.exit(1);
    }
    const userConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    
    const REQUIRED_CONFIG_KEYS = [
        'botMode',
        'apiSettings.chain',
        'meteoraConfig.solPerPosition',
        'exitConfig.tpPercentage'
    ];
    for (const keyPath of REQUIRED_CONFIG_KEYS) {
        const keys = keyPath.split('.');
        let current = userConfig;
        for (const k of keys) {
            if (current === undefined || !(k in current)) {
                console.warn(`[Config Warning] Missing required key: ${keyPath}`);
                break;
            }
            current = current[k];
        }
    }
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
    let isMonitoring = false;
    setInterval(async () => {
        if (isMonitoring) {
            console.log(`[Monitor] Previous loop still running. Skipping to prevent overlap.`);
            return;
        }
        isMonitoring = true;
        try {
            await monitoringLoop(connection, walletKeypair);
        } catch (e) {
            console.error('[Monitor] Error in monitoring loop:', e);
        } finally {
            isMonitoring = false;
        }
    }, checkInterval);
    console.log(`Started Exit Monitoring Loop (Interval: ${checkInterval/1000}s)`);

    // --- Telegram Report Cron Job ---
    const reportIntervalMinutes = userConfig.monitoringConfig?.monitoringIntervalMinutes || 20;
    let reportCronExpression = `*/${reportIntervalMinutes} * * * *`;
    if (reportIntervalMinutes < 1) reportCronExpression = `* * * * *`;
    
    async function sendDashboardReport() {
        let rawPositions = readState();
        // De-duplicate by positionPubKey (prefer auto over manual)
        const posMap = new Map();
        rawPositions.forEach(p => {
            if (!posMap.has(p.positionPubKey) || p.openedBy === 'auto') {
                posMap.set(p.positionPubKey, p);
            }
        });
        let currentActivePositions = [...posMap.values()];
        
        let meteoraDetails = null;
        let solBalance = 0;
        try {
            if (walletKeypair && walletKeypair.publicKey) {
                solBalance = (await connection.getBalance(walletKeypair.publicKey)) / 1e9;
                meteoraDetails = await fetchMeteoraPositionDetails(walletKeypair.publicKey.toBase58());
            }
        } catch(e) {
            console.log(`[Report] Error fetching meteora/wallet details: ${e.message}`);
        }

        if (meteoraDetails !== null) {
            // Filter out positions that are no longer open in Meteora API
            const openPubKeys = Object.keys(meteoraDetails);
            const actuallyOpen = currentActivePositions.filter(p => openPubKeys.includes(p.positionPubKey));
            
            // If some positions are closed on-chain but still in state, clean them up locally
            // ONLY IF they are older than 30 minutes to prevent deleting new positions due to Datapi lag
            const closedPositions = currentActivePositions.filter(p => !openPubKeys.includes(p.positionPubKey));
            const now = Date.now();
            closedPositions.forEach(p => {
                const ageMinutes = p.timestamp ? (now - p.timestamp) / 60000 : 0;
                if (ageMinutes > 30) {
                    console.log(`[Report] Auto-removing position ${p.positionPubKey} from state as it's no longer open on Meteora (age: ${ageMinutes.toFixed(1)}m).`);
                    removePosition(p.positionPubKey);
                } else {
                    console.log(`[Report] Position ${p.positionPubKey} missing from Datapi, but it's only ${ageMinutes.toFixed(1)}m old. Keeping it in state.`);
                    actuallyOpen.push(p); // Put it back since it's probably just Datapi lagging
                }
            });
            
            currentActivePositions = actuallyOpen;
        }

        const currentConfigPath = path.join(__dirname, '..', 'user-config.json');
        let currentMaxPositions = 1;
        try {
            const currentConfig = JSON.parse(fs.readFileSync(currentConfigPath, 'utf-8'));
            currentMaxPositions = currentConfig.monitoringConfig?.maxActivePositions || 1;
        } catch(e) {}

        let msg = `📊 *Wallet & Open Positions*\n─────────────────\n`;
        msg += `💳 *Wallet Balance*: ${solBalance.toFixed(4)} SOL\n`;
        msg += `📈 *Active*: ${currentActivePositions.length}/${currentMaxPositions} Limit\n─────────────────\n\n`;

        if (currentActivePositions.length === 0) {
            msg += `No active positions.`;
            sendMessage(msg);
        } else {
            const aiPositions = currentActivePositions.filter(p => p.openedBy === "auto");
            const manualPositions = currentActivePositions.filter(p => p.openedBy === "manual");

            let index = 1;
            
            const formatAge = (mins) => {
                if (mins < 60) return `${mins}m`;
                const h = Math.floor(mins / 60);
                const m = mins % 60;
                return `${h}h ${m}m`;
            };
            
            if (aiPositions.length > 0) {
                msg += `*AI Positions*\n`;
                aiPositions.forEach(pos => {
                    const ageMinutes = pos.timestamp ? Math.floor((Date.now() - pos.timestamp) / 60000) : 0;
                    const details = (meteoraDetails && ageMinutes >= 1) ? meteoraDetails[pos.positionPubKey] : null;
                    const investedStr = typeof pos.investedSol === 'number' ? pos.investedSol.toFixed(4) : pos.investedSol;
                    
                    const closeModeIcon = (pos.closeMode || 'auto') === 'auto' ? '🤖 Auto' : '👤 Manual';
                    
                    const safeSymbol = (pos.tokenSymbol || 'Unknown').replace(/[_*`\[\]]/g, '');
                    msg += `${index}. 🤖 *${safeSymbol}-SOL*\n`;
                    if (details) {
                        const pnlSign = details.pnlUsd >= 0 ? "+" : "-";
                        const pnlColor = details.pnlUsd >= 0 ? "🟢" : "🔴";
                        let rangeStatus = details.inRange ? "✅ In Range" : "⚠️ OOR";
                        if (!details.inRange) {
                            let oorStrParts = [];
                            if (pos.oorTimestamp) {
                                const oorMins = Math.floor((Date.now() - pos.oorTimestamp) / 60000);
                                oorStrParts.push(`${formatAge(oorMins)}`);
                            }
                            if (pos.activeBinId !== undefined && pos.minBinId !== undefined && pos.maxBinId !== undefined) {
                                let binsOOR = 0;
                                if (pos.activeBinId < pos.minBinId) binsOOR = pos.minBinId - pos.activeBinId;
                                else if (pos.activeBinId > pos.maxBinId) binsOOR = pos.activeBinId - pos.maxBinId;
                                if (binsOOR > 0) oorStrParts.push(`${binsOOR} bins`);
                            }
                            if (oorStrParts.length > 0) {
                                rangeStatus += ` (${oorStrParts.join(' | ')})`;
                            }
                        }
                        
                        msg += `   ${pnlColor} PnL: ${pnlSign}$${Math.abs(details.pnlUsd).toFixed(2)} (${pnlSign}${Math.abs(details.pnlPct).toFixed(2)}%)\n`;
                        msg += `   💎 Fees: $${details.unclaimedFeesUsd.toFixed(4)} | 💰 Value: $${details.totalValueUsd.toFixed(4)}\n`;
                        msg += `   ⏱ Age: ${formatAge(ageMinutes)} | ⚙️ ${closeModeIcon}\n`;
                        msg += `   ${rangeStatus}\n`;
                        if (pos.entryReason) {
                            const safeReason = pos.entryReason.replace(/[_*`\[\]]/g, '');
                            msg += `   💡 Reason: _${safeReason}_\n`;
                        }
                    } else {
                        msg += `   Invested: ${investedStr} SOL\n`;
                        msg += `   ⏱ Age: ${formatAge(ageMinutes)} | ⚙️ ${closeModeIcon}\n`;
                        if (pos.entryReason) {
                            const safeReason = pos.entryReason.replace(/[_*`\[\]]/g, '');
                            msg += `   💡 Reason: _${safeReason}_\n`;
                        }
                    }
                    msg += `\n`;
                    index++;
                });
            }
            
            if (manualPositions.length > 0) {
                msg += `*Manual Positions*\n`;
                manualPositions.forEach(pos => {
                    const ageMinutes = pos.timestamp ? Math.floor((Date.now() - pos.timestamp) / 60000) : 0;
                    const details = (meteoraDetails && ageMinutes >= 1) ? meteoraDetails[pos.positionPubKey] : null;
                    const investedStr = typeof pos.investedSol === 'number' ? pos.investedSol.toFixed(4) : pos.investedSol;
                    
                    const closeModeIcon = (pos.closeMode || 'auto') === 'auto' ? '🤖 Auto' : '👤 Manual';
                    
                    const safeSymbol = (pos.tokenSymbol || 'Unknown').replace(/[_*`\[\]]/g, '');
                    msg += `${index}. 👤 *${safeSymbol}/SOL* 🔒\n`;
                    if (details) {
                        const pnlSign = details.pnlUsd >= 0 ? "+" : "-";
                        const pnlColor = details.pnlUsd >= 0 ? "🟢" : "🔴";
                        let rangeStatus = details.inRange ? "✅ In Range" : "⚠️ OOR";
                        if (!details.inRange) {
                            let oorStrParts = [];
                            if (pos.oorTimestamp) {
                                const oorMins = Math.floor((Date.now() - pos.oorTimestamp) / 60000);
                                oorStrParts.push(`${formatAge(oorMins)}`);
                            }
                            if (pos.activeBinId !== undefined && pos.minBinId !== undefined && pos.maxBinId !== undefined) {
                                let binsOOR = 0;
                                if (pos.activeBinId < pos.minBinId) binsOOR = pos.minBinId - pos.activeBinId;
                                else if (pos.activeBinId > pos.maxBinId) binsOOR = pos.activeBinId - pos.maxBinId;
                                if (binsOOR > 0) oorStrParts.push(`${binsOOR} bins`);
                            }
                            if (oorStrParts.length > 0) {
                                rangeStatus += ` (${oorStrParts.join(' | ')})`;
                            }
                        }
                        
                        msg += `   ${pnlColor} PnL: ${pnlSign}$${Math.abs(details.pnlUsd).toFixed(2)} (${pnlSign}${Math.abs(details.pnlPct).toFixed(2)}%)\n`;
                        msg += `   💎 Fees: $${details.unclaimedFeesUsd.toFixed(4)} | 💰 Value: $${details.totalValueUsd.toFixed(4)}\n`;
                        msg += `   ⏱ Age: ${formatAge(ageMinutes)} | ⚙️ ${closeModeIcon}\n`;
                        msg += `   ${rangeStatus}\n`;
                        if (pos.entryReason) {
                            const safeReason = pos.entryReason.replace(/[_*`\[\]]/g, '');
                            msg += `   💡 Reason: _${safeReason}_\n`;
                        }
                    } else {
                        msg += `   Invested: ${investedStr} SOL\n`;
                        msg += `   ⏱ Age: ${formatAge(ageMinutes)} | ⚙️ ${closeModeIcon}\n`;
                        if (pos.entryReason) {
                            const safeReason = pos.entryReason.replace(/[_*`\[\]]/g, '');
                            msg += `   💡 Reason: _${safeReason}_\n`;
                        }
                    }
                    msg += `\n`;
                    index++;
                });
            }
            
            msg += `────────────────`;
            sendMessage(msg);
        }
    }

    cron.schedule(reportCronExpression, sendDashboardReport);
    console.log(`Started Telegram Report Cron Job (Interval: ${reportIntervalMinutes}m)`);

    // --- Sync Manual Positions Cron Job ---
    cron.schedule('*/5 * * * *', async () => {
        const synced = await syncManualPositions(connection, walletKeypair);
        if (synced && synced.length > 0) {
            let msg = `🔄 *Auto-Sync Manual Positions*\nFound and tracking ${synced.length} new LP position(s):\n\n`;
            synced.forEach(pos => {
                msg += `- Token: *${pos.tokenMint}*\n  Position: \`${pos.positionPubKey}\`\n\n`;
            });
            sendMessage(msg);
        }
    });
    console.log(`Started Sync Manual Positions Cron Job (Interval: 5m)`);

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
            const rawActivePositions = readState();
            // De-duplicate by positionPubKey for accurate slot counting
            const uniqueActive = [...new Map(rawActivePositions.map(p => [p.positionPubKey, p])).values()];
            
            if (uniqueActive.length >= currentMaxPositions) {
                console.log(`[Scraper] Active positions (${uniqueActive.length}) reached max limit (${currentMaxPositions}). Skipping scraper.`);
                return;
            }
            
            console.log(`[Scraper] Starting scheduled scrape (Cron: ${cronExpression})...`);
            await runScraper();
            
            await processCandidates({
                autoEntry: (currentConfig.monitoringConfig?.entryMode || "auto") === "auto",
                maxPositions: currentMaxPositions,
                botConfig: currentConfig.meteoraConfig || botConfig,
                connection: connection,
                walletKeypair: walletKeypair,
                botMode: currentConfig.botMode || botMode
            });
        } catch (e) {
            console.error('[Scraper] Error in cron job:', e);
        } finally {
            isScraperRunning = false;
        }
    });
    console.log(`Started Scraper Cron Job (Interval: ${scraperIntervalMinutes}m)`);

    // --- Initial Entry Logic (Startup) ---
    console.log(`[Startup] Running initial startup routine...`);
    try {
        const synced = await syncManualPositions(connection, walletKeypair);
        if (synced && synced.length > 0) {
            let msg = `🔄 *Startup Sync*\nFound and tracking ${synced.length} manual LP position(s).\n`;
            sendMessage(msg);
        }
        
        // Show dashboard wallet and positions on startup
        await sendDashboardReport();
        
        const currentConfigPath = path.join(__dirname, '..', 'user-config.json');
        let currentMaxPositions = maxPositions;
        try {
            const currentConfig = JSON.parse(fs.readFileSync(currentConfigPath, 'utf-8'));
            currentMaxPositions = currentConfig.monitoringConfig?.maxActivePositions || maxPositions;
        } catch(e) {}
        
        const rawStartupPositions = readState();
        // De-duplicate by positionPubKey for accurate slot counting
        const uniqueStartup = [...new Map(rawStartupPositions.map(p => [p.positionPubKey, p])).values()];
        if (uniqueStartup.length >= currentMaxPositions) {
            console.log(`[Startup] Active positions (${uniqueStartup.length}) reached max limit (${currentMaxPositions}). Skipping initial scraper.`);
        } else {
            isScraperRunning = true;
            try {
                console.log(`[Startup] Running initial scrape and screening...`);
                await runScraper();
                await processCandidates({
                    autoEntry: autoEntry,
                    maxPositions: currentMaxPositions,
                    botConfig: botConfig,
                    connection: connection,
                    walletKeypair: walletKeypair,
                    botMode: botMode
                });
            } finally {
                isScraperRunning = false;
            }
        }
    } catch (e) {
        console.error('[Startup Error]:', e);
    }
}

runBot();

// Health Check Endpoint
const http = require('http');
http.createServer((req, res) => {
    try {
        const state = readState();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            activePositions: state.length,
            uptime: process.uptime(),
            mode: botMode
        }));
    } catch(e) {
        res.writeHead(500);
        res.end(JSON.stringify({ status: 'error', message: e.message }));
    }
}).listen(3001);
