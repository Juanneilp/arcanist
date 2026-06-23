const { Connection } = require('@solana/web3.js');

async function analyzeTx() {
    const conn = new Connection("https://api.mainnet-beta.solana.com");
    const txid = "4upRSLutN89WkNMqER6Nuwkz7tUi9kkMNHT6NyFbwnsNsdvzf8hm36rpgxAmhTrqYadBzzUWZ3DcPFz7SUMSCkqD";
    
    console.log(`Fetching TX: ${txid}`);
    const tx = await conn.getTransaction(txid, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed"
    });

    if (!tx) {
        console.log("Transaction not found.");
        return;
    }

    console.log(`Fee: ${tx.meta.fee / 1e9} SOL`);
    
    const preBalances = tx.meta.preBalances;
    const postBalances = tx.meta.postBalances;
    const accountKeys = tx.transaction.message.staticAccountKeys;

    // Find the payer (usually index 0)
    const payerIndex = 0;
    const payerPre = preBalances[payerIndex];
    const payerPost = postBalances[payerIndex];
    const totalDeducted = (payerPre - payerPost) / 1e9;

    console.log(`Total SOL deducted from payer: ${totalDeducted.toFixed(6)} SOL`);

    // Let's analyze log messages to see if InitializeBinArray was called
    const logs = tx.meta.logMessages || [];
    console.log("\n--- Log Messages ---");
    let initBinArrayCount = 0;
    let initPositionCount = 0;
    let increaseLengthCount = 0;

    for (const log of logs) {
        if (log.includes("Instruction: InitializeBinArray")) {
            initBinArrayCount++;
        }
        if (log.includes("Instruction: InitializePosition")) {
            initPositionCount++;
        }
        if (log.includes("Instruction: IncreasePositionLength")) {
            increaseLengthCount++;
        }
        console.log(log);
    }

    console.log(`\n--- Summary ---`);
    console.log(`InitializeBinArray calls: ${initBinArrayCount}`);
    console.log(`InitializePosition calls: ${initPositionCount}`);
    console.log(`IncreasePositionLength calls: ${increaseLengthCount}`);
}

analyzeTx().catch(console.error);
