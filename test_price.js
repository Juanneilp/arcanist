const DLMM = require('@meteora-ag/dlmm').default || require('@meteora-ag/dlmm');
const { Connection, PublicKey } = require('@solana/web3.js');
async function test() {
  const conn = new Connection('https://api.mainnet-beta.solana.com');
  const pool = await DLMM.create(conn, new PublicKey('8sQZ4H4jqnFwUG8e2Y9Sbr3gJxL4cVssc7eQz7M19t7y'));
  const activeBin = await pool.getActiveBin();
  console.log('activeBin.price:', activeBin.price);
  
  const currentPrice = pool.fromPricePerLamport(Number(activeBin.price));
  console.log('fromPricePerLamport:', currentPrice);
  
  const minPriceUI = Number(currentPrice) * 0.1;
  const maxPriceUI = Number(currentPrice) * 1.01;
  console.log('minPriceUI (-90%):', minPriceUI, 'minBinId:', pool.getBinIdFromPrice(minPriceUI, true));
  console.log('maxPriceUI (+1%):', maxPriceUI, 'maxBinId:', pool.getBinIdFromPrice(maxPriceUI, false));
  
  const priceDirect = Number(activeBin.price);
  const minPriceDirect = priceDirect * 0.1;
  const maxPriceDirect = priceDirect * 1.01;
  console.log('minPriceDirect (-90%):', minPriceDirect, 'minBinId:', pool.getBinIdFromPrice(minPriceDirect, true));
  console.log('maxPriceDirect (+1%):', maxPriceDirect, 'maxBinId:', pool.getBinIdFromPrice(maxPriceDirect, false));
}
test();
