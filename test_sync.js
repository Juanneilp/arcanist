const DLMM = require('@meteora-ag/dlmm').default || require('@meteora-ag/dlmm');
const { Connection, PublicKey } = require('@solana/web3.js');
async function test() {
  const conn = new Connection('https://api.mainnet-beta.solana.com');
  const user = new PublicKey('6sj2JYwiwxEeiY8jim1BRy6mPmULWW97WMab7qVeq9b1');
  const lbclmmProgramId = new PublicKey(DLMM.LBCLMM_PROGRAM_IDS['mainnet-beta']);
  const accounts = await conn.getProgramAccounts(lbclmmProgramId, {
    filters: [DLMM.positionOwnerFilter(user)],
    commitment: 'confirmed'
  });
  if (accounts.length > 0) {
      const lbPair = new PublicKey(accounts[0].account.data.slice(8, 40));
      const poolInstance = await DLMM.create(conn, lbPair);
      const { userPositions } = await poolInstance.getPositionsByUserAndLbPair(user);
      console.log('lowerBinId:', userPositions[0].positionData.lowerBinId);
      console.log('upperBinId:', userPositions[0].positionData.upperBinId);
  }
}
test();
