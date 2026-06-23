const { encryptEnvRaw } = require('./envcrypt.cjs');

try {
  const result = encryptEnvRaw();
  console.log(`Successfully encrypted ${result.rawPath} to ${result.outPath}`);
  
  // Best practice: Hapus .env.raw setelah dienkripsi
  const fs = require('fs');
  fs.unlinkSync(result.rawPath);
  console.log(`Bagus! File ${result.rawPath} asli telah otomatis dihapus demi keamanan.`);
  
  console.log("Make sure to keep your .envrypt key safe and do not commit it!");
} catch (e) {
  console.error("Error encrypting env:", e.message);
  process.exit(1);
}
