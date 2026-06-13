const { Connection, PublicKey } = require('@solana/web3.js');
const DLMM = require('@meteora-ag/dlmm');
const { exec } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const execAsync = util.promisify(exec);

const TOKEN = 'Tqj8yFmagrg7oorpQkVGYR52r96RFTamvWfth9bpump';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'user-config.json'), 'utf-8'));
const botConfig = config.meteoraConfig;

async function run() {
    console.log(`=== STUDY CASE: ${TOKEN} ===`);
    
    console.log(`\n1. Checking Meteora Pools using DexScreener Integration...`);
    let targetPoolData = null;
    try {
        const dsRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${TOKEN}`);
        const dsData = await dsRes.json();
        
        let poolAddresses = [];
        if (dsData && dsData.pairs) {
            const meteoraPairs = dsData.pairs.filter(p => 
                p.dexId === 'meteora' && 
                ((p.baseToken.address === TOKEN && p.quoteToken.address === WSOL_MINT) || 
                 (p.baseToken.address === WSOL_MINT && p.quoteToken.address === TOKEN))
            );
            poolAddresses = meteoraPairs.map(p => p.pairAddress);
        }
        console.log(`- DexScreener found ${poolAddresses.length} Meteora pairs:`, poolAddresses);
        
        const matchingPools = [];
        for (const address of poolAddresses) {
            const pRes = await fetch(`https://dlmm.datapi.meteora.ag/pools/${address}`);
            if (pRes.ok) {
                const poolData = await pRes.json();
                if (poolData && poolData.address) {
                    poolData.liquidity = poolData.tvl;
                    matchingPools.push(poolData);
                }
            }
        }
        console.log(`- DataPi retrieved ${matchingPools.length} pool details.`);
        
        const filtered = matchingPools.filter(p => p.pool_config.bin_step >= botConfig.minBinStep && p.pool_config.bin_step <= botConfig.maxBinStep);
        console.log(`- Found ${filtered.length} pools matching binStep ${botConfig.minBinStep}-${botConfig.maxBinStep}.`);
        
        if (filtered.length > 0) {
            targetPoolData = filtered.sort((a, b) => b.liquidity - a.liquidity)[0];
            console.log(`- Selected Pool: ${targetPoolData.address} (Liquidity: ${targetPoolData.liquidity}, Bin Step: ${targetPoolData.pool_config.bin_step})`);
        }
    } catch (e) {
        console.error("- Error fetching pools:", e.message);
    }

    if (targetPoolData) {
        console.log(`\n2. Calculating Entry Range (Refundable & Wide Range Logic)...`);
        try {
            const connection = new Connection(process.env.RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed');
            const poolAddress = new PublicKey(targetPoolData.address);
            const dlmmPool = await DLMM.create(connection, poolAddress);
            
            const activeBin = await dlmmPool.getActiveBin();
            console.log(`- Active Bin ID: ${activeBin.binId}`);
            console.log(`- Active Bin Price: ${activeBin.price} (Tokens per Token)`);
            
            const isSolX = dlmmPool.tokenX.publicKey.toBase58() === WSOL_MINT;
            console.log(`- Is SOL Token X?: ${isSolX}`);
            
            const dist1 = Math.abs(botConfig.minRange); // e.g. |-90| = 90
            const dist2 = Math.abs(botConfig.maxRange); // e.g. |1| = 1
            const lowerOffset = Math.min(dist1, dist2); // 1
            const upperOffset = Math.max(dist1, dist2); // 90
            
            let minBin, maxBin;
            if (isSolX) {
                minBin = activeBin.binId + lowerOffset;
                maxBin = activeBin.binId + upperOffset;
            } else {
                minBin = activeBin.binId - upperOffset;
                maxBin = activeBin.binId - lowerOffset;
            }
            
            console.log(`- Configured minRange: ${botConfig.minRange}, maxRange: ${botConfig.maxRange}`);
            console.log(`- Evaluated lowerOffset (bins away): ${lowerOffset}`);
            console.log(`- Evaluated upperOffset (bins away): ${upperOffset}`);
            console.log(`- Target Bin ID Range: [${minBin}, ${maxBin}]`);
            
            const minBinPrice = dlmmPool.fromBinId({ binId: minBin });
            const maxBinPrice = dlmmPool.fromBinId({ binId: maxBin });
            
            console.log(`- Closest Entry Price: ${isSolX ? minBinPrice : maxBinPrice} ${isSolX ? 'Meme per SOL' : 'SOL per Meme'}`);
            console.log(`- Furthest Entry Price: ${isSolX ? maxBinPrice : minBinPrice} ${isSolX ? 'Meme per SOL' : 'SOL per Meme'}`);
            
        } catch(e) {
            console.error("- Error connecting to DLMM:", e);
        }
    }
}
run();
