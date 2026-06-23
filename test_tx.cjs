const { Connection, Keypair, Transaction, SystemProgram, PublicKey } = require('@solana/web3.js');
const connection = new Connection('https://api.mainnet-beta.solana.com');
const kp = Keypair.generate();
async function run() {
    const tx = new Transaction().add(SystemProgram.transfer({
        fromPubkey: kp.publicKey,
        toPubkey: kp.publicKey,
        lamports: 100
    }));
    const b1 = await connection.getLatestBlockhash();
    tx.recentBlockhash = b1.blockhash;
    tx.feePayer = kp.publicKey;
    tx.sign(kp);
    console.log("Sig 1:", tx.signatures[0].signature.toString('base64'));
    
    // simulate retry
    const b2 = await connection.getLatestBlockhash();
    tx.recentBlockhash = b2.blockhash;
    tx.sign(kp);
    console.log("Sig 2:", tx.signatures[0].signature.toString('base64'));
    if (tx.signatures[0].signature.toString('base64') !== tx.signatures[1]?.signature?.toString('base64')) {
        console.log("SUCCESS: Re-signing replaces signature");
    }
}
run();
