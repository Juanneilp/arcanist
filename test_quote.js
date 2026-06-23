const DLMM = require('@meteora-ag/dlmm').default || require('@meteora-ag/dlmm');
const { Connection, PublicKey } = require('@solana/web3.js');
async function test() {
  const conn = new Connection('https://api.mainnet-beta.solana.com');
  const pool = await DLMM.create(conn, new PublicKey('8sQZ4H4jqnFwUG8e2Y9Sbr3gJxL4cVssc7eQz7M19t7y'));
  const activeBin = await pool.getActiveBin();
  
  const minPrice = Number(activeBin.price) * 0.1;
  const maxPrice = Number(activeBin.price) * 1.01;
  const minBinId = pool.getBinIdFromPrice(minPrice, true);
  const maxBinId = pool.getBinIdFromPrice(maxPrice, false);
  
  const quote = await pool.quoteCreatePosition({
    strategy: {
        maxBinId,
        minBinId,
        strategyType: 0 
    }
  });
  console.log(quote);
}
test();
