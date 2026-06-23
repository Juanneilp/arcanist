const { Connection, PublicKey } = require('@solana/web3.js');
const DLMM = require('@meteora-ag/dlmm').default;
async function run() {
    const conn = new Connection("https://api.mainnet-beta.solana.com");
    const pubKey = new PublicKey("GBZtGJTywVTUqUfZa19B4zjKsZdSAm77PQ67YFKXBZWJ");
    const allPositions = await DLMM.getAllLbPairPositionsByUser(conn, pubKey);
    allPositions.forEach((val, key) => {
        console.log(key, typeof val, Array.isArray(val) ? "Array" : "Not Array");
        console.log("Keys in val:", Object.keys(val));
    });
}
run().catch(console.error);
