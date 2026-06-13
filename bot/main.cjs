const fs = require('fs');
const path = require('path');
const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58');
const { fetchMeteoraPools, addLiquidity, removeLiquidity, swapTokenToSol } = require('./solana-dex.cjs');
const { readState, addPosition, removePosition } = require('./state.cjs');
const { screenCandidates } = require('./ai-agent.cjs');
const { sendMessage } = require('./telegram.cjs');

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

// Placeholder for exit trigger
async function evaluateExitCondition(position) {
    // TODO: Discuss and implement exit logic.
    // Return true if position should be closed.
    return false; // Dummy
}

async function monitoringLoop(connection, walletKeypair) {
    const configPath = path.join(__dirname, '..', 'user-config.json');
    let userConfig;
    try {
        userConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (e) {
        return;
    }
    
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
                await removeLiquidity(connection, walletKeypair, pos.poolAddress, pos.positionPubKey);
                sendMessage(`✅ Liquidity Removed for ${pos.tokenSymbol}`);
                
                // 2. Remove from active state
                removePosition(pos.positionPubKey);
                
                // 3. Dust Sweeper
                const balanceUi = await getTokenBalance(connection, walletKeypair.publicKey, pos.tokenMint);
                if (balanceUi > 0) {
                    sendMessage(`🧹 Dust Sweeping: Found ${balanceUi} ${pos.tokenSymbol}`);
                    const swapResult = await swapTokenToSol(connection, walletKeypair, pos.tokenMint, balanceUi);
                    if (!swapResult.skipped) {
                        sendMessage(`✅ Swap Success! Reclaimed ~${swapResult.expectedSolOut.toFixed(4)} SOL`);
                    } else {
                        sendMessage(`ℹ️ Dust value too low (~$${swapResult.usdValue.toFixed(2)}). Skipped swap.`);
                    }
                }
            } catch (e) {
                console.error(`Error closing position ${pos.positionPubKey}:`, e);
                sendMessage(`❌ *Error Closing Position* ${pos.tokenSymbol}: ${e.message}`);
            }
        }
    }
}

async function runBot() {
    console.log("Starting Arcanist DLMM Bot...");
    sendMessage("🚀 *Arcanist DLMM Bot Started*");
    
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

    const configPath = path.join(__dirname, '..', 'user-config.json');
    if (!fs.existsSync(configPath)) {
        console.error("user-config.json not found!");
        process.exit(1);
    }
    const userConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const botConfig = userConfig.meteoraConfig || { solAmountToLP: 0.01, binRange: 10, strategyType: 0 };
    const autoEntry = userConfig.monitoringConfig?.autoEntryEnabled ?? true;
    const maxPositions = userConfig.monitoringConfig?.maxActivePositions || 2;

    // Start Monitoring Loop
    const checkInterval = (userConfig.monitoringConfig?.checkIntervalSeconds || 30) * 1000;
    setInterval(() => monitoringLoop(connection, walletKeypair), checkInterval);
    console.log(`Started Monitoring Loop (Interval: ${checkInterval/1000}s)`);

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
                        if (pools.length === 0) {
                            console.warn(`No Meteora pool found for ${token.symbol}/SOL.`);
                            continue;
                        }
                        
                        const targetPool = pools.sort((a, b) => b.liquidity - a.liquidity)[0];
                        const solLamportsToLP = Math.floor(botConfig.solAmountToLP * 1e9);
                        
                        console.log(`[SIMULATED] Adding Single-Sided SOL Liquidity...`);
                        const result = await addLiquidity(connection, walletKeypair, targetPool.address, WSOL_MINT, solLamportsToLP, botConfig.binRange, { type: botConfig.strategyType });
                        
                        addPosition({
                            positionPubKey: result.positionPubKey,
                            poolAddress: targetPool.address,
                            tokenMint: token.address,
                            tokenSymbol: token.symbol,
                            openedBy: "auto"
                        });
                        
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
