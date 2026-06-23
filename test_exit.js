const { evaluateExitCondition } = require('./bot/monitor.cjs');

async function runTest() {
    console.log("--- TEST 1: New Token (Not enough klines) with OOR ---");
    // Mocking GMGN response inside monitor.cjs is hard because it uses spawnAsync.
    // However, if we pass a tokenMint that is valid, it will fetch real data.
    // Let's use a dummy position.
    const posOOR = {
        tokenMint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB264", // Fake valid address
        tokenSymbol: "FAKE",
        timestamp: Date.now() - (2 * 3600 * 1000), // 2 hours ago
        entryPriceUsd: 0.00002, // fake entry
        activeBinId: 100,
        minBinId: 200,
        maxBinId: 300, // active is 100, min is 200 -> OOR by 100 bins (maxOorDistance is 20)
    };
    
    // We will patch spawnAsync globally for the test to simulate "Not enough klines"
    const apiUtils = require('./bot/api-utils.cjs');
    const originalSpawnAsync = apiUtils.spawnAsync;
    
    apiUtils.spawnAsync = async (...args) => {
        return { stdout: JSON.stringify({ code: 0, list: [ { close: "0.00001", time: Date.now() / 1000 } ] }) }; // Only 1 kline
    };
    
    try {
        const result1 = await evaluateExitCondition(posOOR);
        console.log("Result for Token with 1 kline but OOR by 100 bins:", result1);
        if (result1.shouldExit === false) {
            console.log("❌ BUG DETECTED: OOR was ignored because there were not enough klines.");
        } else {
            console.log("✅ OOR worked.");
        }
    } catch (e) {
        console.error(e);
    }
    
    // Restore
    apiUtils.spawnAsync = originalSpawnAsync;
}

runTest();
