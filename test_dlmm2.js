const { Connection, PublicKey } = require('@solana/web3.js');
const DLMM = require('@meteora-ag/dlmm');
async function run() {
    const conn = new Connection("https://api.mainnet-beta.solana.com");
    const pubKey = new PublicKey("GBZtGJTywVTUqUfZa19B4zjKsZdSAm77PQ67YFKXBZWJ");
    const allPositions = await DLMM.getAllLbPairPositionsByUser(conn, pubKey);
    console.log("Returned:", typeof allPositions);
    console.log("Is Map?", allPositions instanceof Map);
    
    allPositions.forEach((positions, poolAddress) => {
        console.log("Pool:", poolAddress);
        console.log("Positions:", typeof positions, Array.isArray(positions) ? "Array" : "Not Array");
        console.log("Positions keys:", Object.keys(positions));
        console.log(positions);
    });
}
run().catch(console.error);
