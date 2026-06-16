const { PublicKey } = require('@solana/web3.js');
const DLMM = require('@meteora-ag/dlmm');
const { readState, saveState } = require('./state.cjs');
const { fetchWithRetry } = require('./api-utils.cjs');
const jupiter = require('./jupiter.cjs');

async function syncManualPositions(connection, walletKeypair) {
    console.log(`[Sync] Scanning RPC for active DLMM positions owned by wallet...`);
    const lbclmmProgramId = new PublicKey(DLMM.LBCLMM_PROGRAM_IDS['mainnet-beta']);
    
    try {
        const allPositionsMap = await DLMM.getAllLbPairPositionsByUser(connection, walletKeypair.publicKey);
        const onChainPubkeys = [];
        const onChainDetails = {};
        
        allPositionsMap.forEach((positionsInfo, poolAddress) => {
            if (!positionsInfo.lbPairPositionsData) return;
            for (const p of positionsInfo.lbPairPositionsData) {
                const xAmount = Number(p.positionData.totalXAmount);
                const yAmount = Number(p.positionData.totalYAmount);
                
                if (xAmount === 0 && yAmount === 0) continue;
                
                const pubKeyStr = p.publicKey.toBase58();
                onChainPubkeys.push(pubKeyStr);
                onChainDetails[pubKeyStr] = {
                    poolAddress,
                    posData: p
                };
            }
        });
        
        let state = readState();
        let removedCount = 0;
        const activeState = [];
        
        for (const pos of state) {
            const ageMinutes = pos.timestamp ? Math.floor((Date.now() - pos.timestamp) / 60000) : 0;
            if (!onChainPubkeys.includes(pos.positionPubKey)) {
                if (ageMinutes > 5) {
                    console.log(`[Sync] Removing ghost position ${pos.tokenSymbol} (${pos.positionPubKey}) - Not found on-chain.`);
                    removedCount++;
                    continue;
                } else {
                    console.log(`[Sync] Position ${pos.tokenSymbol} not found on-chain, but age is only ${ageMinutes}m. Waiting...`);
                }
            }
            activeState.push(pos);
        }
        
        if (removedCount > 0) {
            saveState(activeState);
            state = activeState;
            console.log(`[Sync] Cleaned ${removedCount} ghost position(s) from state.`);
        }
        
        let addedCount = 0;
        let syncedPositions = [];
        
        for (const positionPubKeyStr of onChainPubkeys) {
            try {
                if (state.find(p => p.positionPubKey === positionPubKeyStr)) continue;
                
                const { poolAddress, posData } = onChainDetails[positionPubKeyStr];
                let lbPair = new PublicKey(poolAddress);
                
                const poolInstance = await DLMM.create(connection, lbPair, { cluster: "mainnet-beta" });
                const activeBin = await poolInstance.getActiveBin();
                
                const WSOL_MINT = 'So11111111111111111111111111111111111111112';
                let tokenMintStr = poolInstance.tokenX.publicKey.toBase58();
                if (tokenMintStr === WSOL_MINT) {
                    tokenMintStr = poolInstance.tokenY.publicKey.toBase58();
                }
                
                let tokenSymbol = "MANUAL";
                let entryPriceUsd = 0;
                try {
                    const res = await fetchWithRetry(`https://api.dexscreener.com/latest/dex/tokens/${tokenMintStr}`);
                    if (res.ok) {
                        const data = await res.json();
                        if (data && data.pairs && data.pairs.length > 0) {
                            const pair = data.pairs[0];
                            tokenSymbol = pair.baseToken.address === tokenMintStr ? pair.baseToken.symbol : pair.quoteToken.symbol;
                            entryPriceUsd = parseFloat(pair.priceUsd) || 0;
                        }
                    }
                } catch(e) {}
                
                let investedSol = 0;
                try {
                    const solPrice = await jupiter.getSolPriceUsd() || 150;
                    const { userPositions } = await poolInstance.getPositionsByUserAndLbPair(walletKeypair.publicKey);
                    const posData = userPositions.find(p => p.publicKey.toBase58() === positionPubKeyStr);
                    
                    if (posData) {
                        const xAmount = Number(posData.positionData.totalXAmount) / Math.pow(10, poolInstance.tokenX.mint.decimals);
                        const yAmount = Number(posData.positionData.totalYAmount) / Math.pow(10, poolInstance.tokenY.mint.decimals);
                        
                        let totalUsd = 0;
                        if (poolInstance.tokenX.publicKey.toBase58() === WSOL_MINT) {
                            totalUsd = (xAmount * solPrice) + (yAmount * entryPriceUsd);
                        } else {
                            totalUsd = (yAmount * solPrice) + (xAmount * entryPriceUsd);
                        }
                        investedSol = totalUsd / solPrice;
                    }
                } catch(e) {
                    console.log(`[Sync] Warning calculating invested:`, e.message);
                }
                
                let minBinId, maxBinId;
                try {
                    const posAccount = await poolInstance.program.account.positionV2.fetch(new PublicKey(positionPubKeyStr));
                    minBinId = posAccount.lowerBinId;
                    maxBinId = posAccount.upperBinId;
                } catch(e) {
                    console.log(`[Sync] Failed to fetch bin bounds:`, e.message);
                }

                const newPos = {
                    positionPubKey: positionPubKeyStr,
                    poolAddress: lbPair.toBase58(),
                    tokenMint: tokenMintStr,
                    tokenSymbol: tokenSymbol,
                    openedBy: "manual",
                    investedSol: investedSol,
                    entryBinPrice: activeBin.price,
                    entryPriceUsd: entryPriceUsd,
                    minBinId: minBinId,
                    maxBinId: maxBinId,
                    timestamp: Date.now()
                };
                
                state.push(newPos);
                syncedPositions.push(newPos);
                addedCount++;
                console.log(`[Sync] Injected manual position: ${positionPubKeyStr} for token ${tokenSymbol}`);
            } catch(e) {
                // continue
            }
        }
        
        if (addedCount > 0) {
            saveState(state);
            console.log(`[Sync] Added ${addedCount} manual positions to active state.`);
        }
        return syncedPositions;
    } catch(e) {
        console.error(`[Sync Error]`, e.message);
        return [];
    }
}

module.exports = {
    syncManualPositions
};
