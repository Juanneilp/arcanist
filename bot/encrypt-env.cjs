const { encryptEnvRaw } = require('./envcrypt.cjs');

try {
  const result = encryptEnvRaw();
  console.log(`Successfully encrypted ${result.rawPath} to ${result.outPath}`);
  console.log("Make sure to keep your .envrypt key safe and do not commit it!");
} catch (e) {
  console.error("Error encrypting env:", e.message);
  process.exit(1);
}
