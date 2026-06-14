# Laporan Analisis Keamanan Arcanist Bot

Berdasarkan riset mendalam terhadap arsitektur dan kode sumber (*source code*) project `Arcanist`, berikut adalah analisis keamanan terperinci mengenai apakah bot ini sudah aman dari ancaman eksternal (termasuk dari data GMGN AI, Telegram, dan interaksi pengguna lainnya).

---

## 1. Ringkasan Eksekutif (Executive Summary)

**Apakah project ini sudah aman dari eksternal (termasuk GMGN AI fork)?**
**TIDAK.** Project ini memiliki **celah keamanan kritis (Critical Vulnerabilities)** yang memungkinkan pihak eksternal untuk:
1. Mengambil alih server Anda (melalui *Command Injection*).
2. Mengontrol bot Telegram Anda dan menguras *limit* API AI Anda.
3. Membaca posisi *trading* Anda tanpa izin.

Meskipun beberapa praktik dasar keamanan sudah diterapkan (seperti penggunaan `.env`), cara bot memproses data eksternal (GMGN) dan cara bot berinteraksi via Telegram masih sangat rentan.

---

## 2. Apa yang Sudah Aman (Good Security Practices)

Beberapa bagian dari sistem telah menerapkan praktik keamanan yang baik:
- **Pemisahan Kredensial (.env):** Token Bot Telegram, Private Key Wallet Solana, dan API Keys (GMGN, OpenRouter) disimpan di dalam file `.env` dan tidak di-*hardcode* di dalam *source code*.
- **Graceful Shutdown:** Bot menangani sinyal `SIGINT` dan `SIGTERM` dengan baik (pada `telegram.cjs`), mencegah kerusakan state (kondisi) saat server direstart.
- **Retry Mechanism:** Operasi RPC Solana dan HTTP Fetch (di `api-utils.cjs`) menggunakan *retry wrapper*. Ini mencegah *crash* mendadak akibat *rate limit* (429) atau gangguan jaringan eksternal.

---

## 3. Celah Keamanan Kritis & Belum Aman (Vulnerabilities)

Berikut adalah ancaman dan celah keamanan yang ditemukan di dalam sistem Anda saat ini:

### A. Command Injection / Remote Code Execution (RCE) - [Kritis/Critical]
File **`bot/main.cjs`** dan **`bot/scraper.cjs`** menggunakan fungsi `execAsync` untuk menjalankan `gmgn-cli` melalui *shell*. Variabel digabungkan secara langsung (string concatenation) ke dalam perintah bash:

```javascript
// Contoh di main.cjs (Line 55)
const cmd = `GMGN_API_KEY=${apiKey} npx gmgn-cli market kline --chain ${chain} --address ${position.tokenMint} --resolution 15m --from ${fromTimestamp} --raw`;
const { stdout } = await execAsync(cmd, { maxBuffer: 1024 * 1024 * 10 });
```

**Ancaman:** Jika GMGN AI API (atau *scraper* mana pun) mengembalikan data `tokenMint` atau `address` yang mengandung karakter manipulasi bash seperti `111111; rm -rf /;`, perintah tersebut akan **dieksekusi oleh server Anda**. Pihak eksternal (developer token palsu, atau API eksternal yang di-hack) dapat dengan mudah menghapus seluruh file di VPS Anda atau mencuri Private Key dari file `.env`.

### B. Telegram Bot Tidak Memiliki Autentikasi (Unauthenticated Access) - [Kritis/Critical]
Di dalam **`bot/telegram.cjs`**, bot dideklarasikan dan menerima perintah `/positions`, `/toggle_auto`, dan `/chat`. Namun, bot **tidak memvalidasi siapa pengirim pesan tersebut**. Variabel `chatId` dari `.env` hanya digunakan untuk bot saat *mengirim* notifikasi.

**Ancaman:** Siapa pun di Telegram yang mengetahui *username* bot Anda dapat:
- Mengetik `/positions` untuk melihat posisi trading Anda.
- Mengetik `/toggle_auto` untuk menyalakan/mematikan mode trading otomatis Anda (sabotase trading).
- Mengetik `/chat` berulang-ulang untuk menguras kuota API OpenRouter/AI Anda, menyebabkan tagihan membengkak.

### C. Injeksi Prompt AI (AI Prompt Injection) - [Menengah/Medium]
Fitur `/chat` (di `telegram.cjs` dan `ai-agent.cjs`) mengirimkan input pengguna mentah (*raw*) langsung ke AI. Jika pihak eksternal bisa mengakses Telegram Bot, mereka dapat memanipulasi *system prompt* untuk memaksa AI melakukan instruksi berbahaya atau memberikan informasi rahasia yang mungkin AI ketahui dari konteks *source code*.

---

## 4. Solusi dan Rekomendasi Perbaikan

Untuk mengamankan project ini dari eksternal, Anda HARUS mengimplementasikan solusi berikut:

### Solusi A: Mencegah Command Injection (RCE)
**Jangan pernah** menggunakan `exec` dengan string *concatenation* untuk variabel eksternal. Gunakan `execFile` atau pisahkan *arguments* dalam bentuk array (*spawn*), sehingga *shell* tidak mengeksekusi parameter sebagai perintah independen.

*Cara Memperbaiki di `main.cjs` dan `scraper.cjs`:*
```javascript
// Ganti execAsync dengan spawnAsync atau execFile
const util = require('util');
const execFile = util.promisify(require('child_process').execFile);

// Alih-alih: const cmd = `... npx gmgn-cli ... ${address}`;
// Gunakan:
const { stdout } = await execFile('npx', [
    'gmgn-cli', 'market', 'kline', 
    '--chain', chain, 
    '--address', position.tokenMint, 
    '--resolution', '15m', 
    '--from', fromTimestamp.toString(), 
    '--raw'
], {
    env: { ...process.env, GMGN_API_KEY: apiKey }
});
```
Dengan cara ini, string berbahaya seperti `"; rm -rf /"` hanya akan dibaca sebagai alamat *address* yang tidak valid (dan akan gagal (error) secara aman), bukan sebagai perintah bash.

### Solusi B: Mengamankan Telegram Bot (Autentikasi)
Setiap kali bot menerima perintah, bot harus mengecek apakah `ID` pengguna/chat cocok dengan `TELEGRAM_CHAT_ID` yang ada di `.env`.

*Cara Memperbaiki di `telegram.cjs`:*
Tambahkan *middleware* atau pengecekan di awal blok handler `bot.use()`:

```javascript
bot.use((ctx, next) => {
    // Pastikan chatId di .env sama dengan ID chat yang mengirim pesan
    if (ctx.chat && ctx.chat.id.toString() === chatId) {
        return next();
    } else {
        console.warn(`Akses ditolak untuk pengguna dengan ID: ${ctx.chat?.id}`);
        // Abaikan pengguna lain (jangan berikan respons)
    }
});
```
Ini akan memblokir semua interaksi dari orang asing di Telegram secara instan.

### Solusi C: Validasi Input Konfigurasi (`user-config.json`)
Bot sering membaca `user-config.json` melalui `fs.readFileSync`. Jika file JSON rusak secara tak sengaja atau tidak valid, aplikasi akan *crash*.
* Solusi: Tambahkan pembungkus `try-catch` dengan skema validasi (misalnya menggunakan *Zod* atau Joi) sebelum *config* diaplikasikan ke *logic bot*. Pastikan ada *fallback/default config* yang memadai.

---

## Kesimpulan

Saat ini, Arcanist Bot **BELUM AMAN** secara arsitektur jika berhadapan dengan *data payload* berbahaya dari eksternal (API GMGN, Token Address) atau dari pengguna Telegram yang iseng. 

Langkah yang **paling mendesak (Urgent)** adalah:
1. Memperbaiki Command Injection di `execAsync`.
2. Menambahkan filter otorisasi (`chatId`) di `telegram.cjs`.

Apabila kedua hal tersebut sudah di-patch, aplikasi akan jauh lebih tahan banting terhadap ancaman *eksternal/fork*.
