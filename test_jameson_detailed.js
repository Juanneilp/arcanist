const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const DLMM = require('@meteora-ag/dlmm');
const BN = require('bn.js');

async function testRanges() {
    const conn = new Connection("https://api.mainnet-beta.solana.com");
    const poolAddress = new PublicKey("8ouXYNyVP2YAbBpWvGq6sXYXKcSybe8XcQiD47mG9ihT");
    const dlmmPool = await DLMM.create(conn, poolAddress, { cluster: "mainnet-beta" });
    const activeBin = await dlmmPool.getActiveBin();
    
    console.log(`Current Active Bin ID: ${activeBin.binId}`);
    console.log(`Current Active Bin Price: ${activeBin.price}`);
    
    // Scenarios
    const scenarios = [
        { name: "User Config (-85% to 1%)", minRange: -85, maxRange: 1 },
        { name: "Bot's exact historical range (approx 10%)", minBinId: -760, maxBinId: -521 },
        { name: "Current -10% to +10%", minRange: -10, maxRange: 10 },
        { name: "Wider -50% to +50%", minRange: -50, maxRange: 50 },
        { name: "Full Range (Meteora UI default style approx -90% to +900%)", minRange: -90, maxRange: 900 },
    ];

    for (const sc of scenarios) {
        let minBin, maxBin;
        if (sc.minBinId !== undefined) {
            minBin = sc.minBinId;
            maxBin = sc.maxBinId;
        } else {
            const currentRawPrice = Number(activeBin.price);
            const minPrice = currentRawPrice * (1 + (sc.minRange / 100));
            const maxPrice = currentRawPrice * (1 + (sc.maxRange / 100));
            
            const rawMinBin = dlmmPool.getBinIdFromPrice(minPrice, true);
            const rawMaxBin = dlmmPool.getBinIdFromPrice(maxPrice, false);
            
            // Assume SOL is Y or X. We just need min and max sorted.
            minBin = Math.min(rawMinBin, rawMaxBin);
            maxBin = Math.max(rawMinBin, rawMaxBin);
        }
        
        console.log(`\n--- Testing Scenario: ${sc.name} ---`);
        console.log(`minBinId: ${minBin}, maxBinId: ${maxBin}`);
        console.log(`Total bins covered: ${Math.abs(maxBin - minBin)}`);
        
        try {
            const quote = await dlmmPool.quoteCreatePosition({
                strategy: {
                    maxBinId: maxBin,
                    minBinId: minBin,
                    strategyType: 0 // Spot
                }
            });
            
            function toSol(val) {
                if (!val) return 0;
                if (BN.isBN(val)) return val.toNumber() / 1e9;
                return Number(val) || 0;
            }
            
            const binArrayCount = quote.binArrayCount ?? quote.binArraysCount ?? 0;
            const binArrayCostSol = toSol(quote.binArrayCost);
            
            console.log(`BinArray count (NON-refundable): ${binArrayCount}`);
            console.log(`BinArray cost (NON-refundable): ${binArrayCostSol.toFixed(6)} SOL`);
        } catch (e) {
            console.error(`Error quoting scenario: ${e.message}`);
        }
    }
}

testRanges().catch(console.error);
