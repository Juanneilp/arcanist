const fs = require("fs");
const path = require("path");
const { loadEnv } = require('./envcrypt.cjs');

try {
  // Load and decrypt environment variables into process.env
  const { encryptedKeys } = loadEnv();
  
  if (encryptedKeys.length === 0) {
    console.log("No encrypted keys found in .env.");
    process.exit(0);
  }

  const rawPath = path.join(__dirname, '..', '.env.raw');
  
  if (fs.existsSync(rawPath)) {
    console.log(`File ${rawPath} already exists! Please edit it directly or delete it to decrypt from .env again.`);
    process.exit(1);
  }

  const lines = [
    "# ==========================================",
    "# FILE INI ADALAH FILE RAHASIA (TIDAK BOLEH DI-COMMIT)",
    "# Di sinilah Anda meletakkan Private Key dan API Key asli Anda.",
    "# ==========================================",
    ""
  ];

  for (const key of encryptedKeys) {
    lines.push(`${key}=${process.env[key]}`);
  }

  fs.writeFileSync(rawPath, lines.join("\n") + "\n");
  console.log(`Successfully decrypted keys and reconstructed ${rawPath}`);
  console.log(`Anda sekarang bisa membuka file .env.raw untuk melihat/mengedit isinya.`);
  console.log(`JANGAN LUPA: Setelah selesai diedit, jalankan kembali 'node bot/encrypt-env.cjs' agar aman!`);
  
} catch (e) {
  console.error("Error decrypting env:", e.message);
  process.exit(1);
}
