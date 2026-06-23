const { Connection, PublicKey } = require('@solana/web3.js');
const DLMM = require('@meteora-ag/dlmm');
const BN = require('bn.js');

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

async function debugJameson() {
    const conn = new Connection("https://api.mainnet-beta.solana.com");
    const poolAddress = new PublicKey("8ouXYNyVP2YAbBpWvGq6sXYXKcSybe8XcQiD47mG9ihT");
    const dlmmPool = await DLMM.create(conn, poolAddress, { cluster: "mainnet-beta" });

    const activeBin = await dlmmPool.getActiveBin();
    console.log(`=== Pool State ===`);
    console.log(`Active Bin ID: ${activeBin.binId}`);
    console.log(`Active Bin Price (raw): ${activeBin.price}`);
    console.log(`Token X: ${dlmmPool.tokenX.publicKey.toBase58()}`);
    console.log(`Token Y: ${dlmmPool.tokenY.publicKey.toBase58()}`);

    const isSolX = dlmmPool.tokenX.publicKey.toBase58() === WSOL_MINT;
    console.log(`\nisSolX: ${isSolX}`);
    console.log(`SOL is token${isSolX ? 'X' : 'Y'}, Meme is token${isSolX ? 'Y' : 'X'}`);

    // user-config.json values
    const minRange = -85;
    const maxRange = 1;

    const currentRawPrice = Number(activeBin.price);
    const minPrice = currentRawPrice * (1 + (minRange / 100));
    const maxPrice = currentRawPrice * (1 + (maxRange / 100));

    console.log(`\n=== Price Calculation ===`);
    console.log(`currentRawPrice: ${currentRawPrice}`);
    console.log(`minPrice (-85%): ${minPrice}`);
    console.log(`maxPrice (+1%):  ${maxPrice}`);

    const rawMinBin = dlmmPool.getBinIdFromPrice(minPrice, true);
    const rawMaxBin = dlmmPool.getBinIdFromPrice(maxPrice, false);

    console.log(`\n=== Raw Bin IDs (from getBinIdFromPrice) ===`);
    console.log(`rawMinBin: ${rawMinBin}`);
    console.log(`rawMaxBin: ${rawMaxBin}`);

    let minBin, maxBin;

    if (isSolX) {
        const sortedMin = Math.min(rawMinBin, rawMaxBin);
        const sortedMax = Math.max(rawMinBin, rawMaxBin);
        minBin = Math.max(sortedMin, activeBin.binId);
        maxBin = Math.max(sortedMax, activeBin.binId);
        console.log(`\n=== isSolX Path ===`);
        console.log(`sortedMin=${sortedMin}, sortedMax=${sortedMax}`);
        console.log(`minBin = max(${sortedMin}, ${activeBin.binId}) = ${minBin}`);
        console.log(`maxBin = max(${sortedMax}, ${activeBin.binId}) = ${maxBin}`);
    } else {
        const sortedMin = Math.min(rawMinBin, rawMaxBin);
        const sortedMax = Math.max(rawMinBin, rawMaxBin);
        minBin = Math.min(sortedMin, activeBin.binId);
        maxBin = Math.min(sortedMax, activeBin.binId);
        console.log(`\n=== !isSolX Path (SOL is Y) ===`);
        console.log(`sortedMin=${sortedMin}, sortedMax=${sortedMax}`);
        console.log(`minBin = min(${sortedMin}, ${activeBin.binId}) = ${minBin}`);
        console.log(`maxBin = min(${sortedMax}, ${activeBin.binId}) = ${maxBin}`);
    }

    const totalBins = maxBin - minBin;
    const isWideRange = totalBins > 69;
    console.log(`\n=== Final Range ===`);
    console.log(`minBin: ${minBin}, maxBin: ${maxBin}`);
    console.log(`Total bins: ${totalBins}`);
    console.log(`isWideRange (>69): ${isWideRange}`);

    // BinArray analysis
    const binArrayMin = Math.floor(minBin / 70);
    const binArrayMax = Math.floor(maxBin / 70);
    console.log(`\n=== BinArray Analysis ===`);
    console.log(`BinArray index for minBin (${minBin}): ${binArrayMin} -> covers bins ${binArrayMin * 70} to ${(binArrayMin + 1) * 70 - 1}`);
    console.log(`BinArray index for maxBin (${maxBin}): ${binArrayMax} -> covers bins ${binArrayMax * 70} to ${(binArrayMax + 1) * 70 - 1}`);
    console.log(`BinArrays spanned: ${binArrayMin} to ${binArrayMax} (total: ${binArrayMax - binArrayMin + 1})`);

    // Now quote
    console.log(`\n=== quoteCreatePosition Result ===`);
    try {
        const quote = await dlmmPool.quoteCreatePosition({
            strategy: {
                maxBinId: maxBin,
                minBinId: minBin,
                strategyType: 0
            }
        });

        function toSol(val) {
            if (!val) return 0;
            if (BN.isBN(val)) return val.toNumber() / 1e9;
            return Number(val) || 0;
        }

        const binArrayCount = quote.binArrayCount ?? quote.binArraysCount ?? 0;
        const binArrayCostSol = toSol(quote.binArrayCost);
        const positionRentSol = toSol(quote.positionRent || quote.positionCost);
        const reallocCostSol = toSol(quote.reallocCost || quote.positionReallocCost);

        console.log(`Position rent (refundable): ${positionRentSol.toFixed(6)} SOL`);
        console.log(`Realloc cost (refundable): ${reallocCostSol.toFixed(6)} SOL`);
        console.log(`BinArray count (NON-refundable): ${binArrayCount}`);
        console.log(`BinArray cost (NON-refundable): ${binArrayCostSol.toFixed(6)} SOL`);
        console.log(`Total quote cost: ${(positionRentSol + reallocCostSol + binArrayCostSol).toFixed(6)} SOL`);

        console.log(`\n=== Full Quote Object Keys ===`);
        console.log(JSON.stringify(quote, (key, value) => {
            if (BN.isBN(value)) return `BN(${value.toString()})`;
            return value;
        }, 2));

    } catch (e) {
        console.error(`Quote error: ${e.message}`);
    }

    // Compare with historical position data
    console.log(`\n=== Comparison with active_positions.json ===`);
    console.log(`Stored minBinId: -760, maxBinId: -521`);
    console.log(`Current computed minBin: ${minBin}, maxBin: ${maxBin}`);
    console.log(`Stored entryBinPrice: 0.015742103772247168018`);
    console.log(`Current activeBin price: ${activeBin.price}`);

    // Also check what happens at the historical price
    console.log(`\n=== Simulating at HISTORICAL entry price ===`);
    const historicalPrice = 0.015742103772247168018;
    const histMinPrice = historicalPrice * (1 + (minRange / 100));
    const histMaxPrice = historicalPrice * (1 + (maxRange / 100));
    const histRawMinBin = dlmmPool.getBinIdFromPrice(histMinPrice, true);
    const histRawMaxBin = dlmmPool.getBinIdFromPrice(histMaxPrice, false);

    let histMinBin, histMaxBin;
    if (isSolX) {
        histMinBin = Math.max(Math.min(histRawMinBin, histRawMaxBin), activeBin.binId);
        histMaxBin = Math.max(Math.max(histRawMinBin, histRawMaxBin), activeBin.binId);
    } else {
        // Historical activeBin was -521 (based on entryBinPrice)
        const histActiveBinId = -521;
        histMinBin = Math.min(Math.min(histRawMinBin, histRawMaxBin), histActiveBinId);
        histMaxBin = Math.min(Math.max(histRawMinBin, histRawMaxBin), histActiveBinId);
    }
    console.log(`Historical rawMinBin: ${histRawMinBin}, rawMaxBin: ${histRawMaxBin}`);
    console.log(`Historical minBin: ${histMinBin}, maxBin: ${histMaxBin}`);
    console.log(`Historical total bins: ${histMaxBin - histMinBin}`);

    const histBinArrayMin = Math.floor(histMinBin / 70);
    const histBinArrayMax = Math.floor(histMaxBin / 70);
    console.log(`Historical BinArrays: ${histBinArrayMin} to ${histBinArrayMax}`);

    // Quote at historical bins
    console.log(`\n=== quoteCreatePosition at HISTORICAL bins ===`);
    try {
        const histQuote = await dlmmPool.quoteCreatePosition({
            strategy: {
                maxBinId: histMaxBin,
                minBinId: histMinBin,
                strategyType: 0
            }
        });
        function toSol(val) {
            if (!val) return 0;
            if (BN.isBN(val)) return val.toNumber() / 1e9;
            return Number(val) || 0;
        }
        const hbc = histQuote.binArrayCount ?? histQuote.binArraysCount ?? 0;
        const hbcost = toSol(histQuote.binArrayCost);
        console.log(`BinArray count (NON-refundable): ${hbc}`);
        console.log(`BinArray cost (NON-refundable): ${hbcost.toFixed(6)} SOL`);
    } catch (e) {
        console.error(`Historical quote error: ${e.message}`);
    }
}

debugJameson().catch(console.error);
