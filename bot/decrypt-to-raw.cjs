const fs = require('fs');
const path = require('path');
const { loadEnv } = require('./envcrypt.cjs');

try {
  // Muat dan dekripsi .env ke memory (process.env)
  const { encryptedKeys } = loadEnv();
  
  const envPath = path.join(__dirname, '..', '.env');
  const rawPath = path.join(__dirname, '..', '.env.raw');

  if (!fs.existsSync(envPath)) {
    console.error("File .env tidak ditemukan!");
    process.exit(1);
  }

  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  const rawLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().toLowerCase() === '# encrypted') {
      continue;
    }
    
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (match && encryptedKeys.includes(match[1])) {
      // Tulis versi unencrypted-nya
      rawLines.push(`${match[1]}=${process.env[match[1]]}`);
    } else {
      rawLines.push(line);
    }
  }

  fs.writeFileSync(rawPath, rawLines.join('\n'));
  console.log("Berhasil! File .env telah didekripsi dan disimpan sebagai .env.raw");
  console.log("Silakan edit file .env.raw, ganti WALLET_PRIVATE_KEY Anda, lalu jalankan: node bot/encrypt-env.cjs");

} catch (err) {
  console.error("Gagal melakukan dekripsi:", err.message);
}
