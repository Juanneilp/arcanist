const DLMM = require('@meteora-ag/dlmm').default || require('@meteora-ag/dlmm');
const { Connection, PublicKey } = require('@solana/web3.js');
async function test() {
  const conn = new Connection('https://api.mainnet-beta.solana.com');
  const pool = await DLMM.create(conn, new PublicKey('8sQZ4H4jqnFwUG8e2Y9Sbr3gJxL4cVssc7eQz7M19t7y'));
  console.log('pool.getBinIdFromPrice exists?', !!pool.getBinIdFromPrice);
  console.log('pool.getBinIdFromPrice:', pool.getBinIdFromPrice.toString());
  
  const getBinIdFromPrice = require('@meteora-ag/dlmm').getBinIdFromPrice;
  console.log('getBinIdFromPrice from package:', getBinIdFromPrice.toString());
}
test();
