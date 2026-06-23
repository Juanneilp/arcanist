const { Connection, Keypair } = require('@solana/web3.js');
const { addLiquidity } = require('./bot/meteora.cjs');

async function test() {
    const conn = new Connection("https://api.mainnet-beta.solana.com");
    // Dummy wallet
    const kp = Keypair.generate();
    
    // params: connection, walletKeypair, poolAddressStr, solMint, solLamports, minRange, maxRange, strategyOptions, mode
    const poolAddress = "8ouXYNyVP2YAbBpWvGq6sXYXKcSybe8XcQiD47mG9ihT";
    const solMint = "So11111111111111111111111111111111111111112";
    const solLamports = 100000000; // 0.1 SOL
    const minRange = -10;
    const maxRange = 10;
    const strategyOptions = { type: 0 };
    
    console.log("Running quote for JAMESON pool...");
    await addLiquidity(conn, kp, poolAddress, solMint, solLamports, minRange, maxRange, strategyOptions, "dry_run");
}

test().catch(console.error);
