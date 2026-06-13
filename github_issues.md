# Draf Issue GitHub

Berikut adalah *draft* untuk 5 Issue yang bisa Anda salin (copy-paste) langsung ke tab **Issues** di repositori GitHub Anda. Penjelasan dibuat mendetail agar *AI Agent* lain atau *Developer Junior* dapat memahami dan mengerjakannya dengan mudah.

---

## Issue 1: [Fitur] Implementasi Logika Strategi Keluar (Take Profit / Stop Loss)

**Judul:** `[Fitur] Implementasi Strategi Keluar & Logika Kondisi pada evaluateExitCondition()`

**Deskripsi:**
```markdown
### Latar Belakang
Saat ini, fungsi `evaluateExitCondition(position)` di `bot/main.cjs` hanyalah *placeholder* statis yang selalu mengembalikan nilai `false`. Ini berarti bot dapat membuka posisi DLMM (Tambah Likuiditas) tetapi tidak akan pernah menutupnya (Hapus Likuiditas), sehingga dompet rentan terhadap *impermanent loss* dan *rug pull*.

### Tujuan
Mengimplementasikan strategi keluar yang kuat dan otomatis untuk menutup posisi dengan aman serta mengamankan keuntungan/mencegah kerugian besar.

### Tugas / Kebutuhan
1. **Logika Take Profit (TP)**: Tutup posisi jika harga token naik sebesar `X%` atau nilai USD posisi melampaui ambang batas tertentu.
2. **Logika Stop Loss (SL)**: Tutup posisi jika harga token turun sebesar `Y%` dari harga masuk.
3. **Keluar Berdasarkan Waktu (Opsional tapi Direkomendasikan)**: Tutup posisi jika sudah terbuka selama lebih dari `Z` jam untuk membebaskan modal.
4. **Keluar Berdasarkan Analisis Teknikal**: Integrasikan dengan logika Supertrend yang ada di `bot/scraper.cjs`. Jika indikator Supertrend untuk token yang dipegang berubah menjadi **Merah/Bearish**, segera picu penutupan posisi.
5. **Konfigurasi**: Tambahkan parameter TP, SL, dan batasan waktu ke `user-config.json` di bawah `exitConfig`.

### Referensi File
- `bot/main.cjs` (Fungsi target: `evaluateExitCondition`)
- `user-config.json`
```

---

## Issue 2: [Fitur] Otomatisasi Scraper Token dengan Penjadwal (Cron Job)

**Judul:** `[Fitur] Otomatisasi Eksekusi Scraper menggunakan Penjadwal / Cron`

**Deskripsi:**
```markdown
### Latar Belakang
Logika scraper (`bot/scraper.cjs`) berhasil mengambil token-token yang sedang tren dari API GMGN, menjalankan filter fundamental dan teknikal, lalu menyimpannya ke `candidates.json`. Namun, scraper ini harus dipicu secara manual. Bot utama (`bot/main.cjs`) hanya membaca `candidates.json` dan tidak memperbaruinya secara otomatis.

### Tujuan
Mengotomatiskan eksekusi `bot/scraper.cjs` sehingga bot terus menerima token kandidat baru tanpa intervensi manual.

### Tugas / Kebutuhan
1. **Pilihan Implementasi**:
   - *Opsi A*: Gunakan `node-cron` di dalam `bot/main.cjs` untuk melakukan `require()` dan mengeksekusi fungsi `runScraper()` secara berkala.
   - *Opsi B*: Konfigurasikan PM2 di `ecosystem.config.cjs` untuk menjalankan `scraper.cjs` pada jadwal cron menggunakan atribut `cron_restart`.
2. Pastikan penulisan bersamaan ke `candidates.json` tidak membuat proses baca pada `main.cjs` menjadi *crash* (implementasikan kunci baca/tulis atau *try-catch buffer*).
3. Tambahkan variabel konfigurasi di `user-config.json` (misalnya, `scraperIntervalMinutes`) untuk menentukan seberapa sering scraper harus berjalan (misalnya, setiap 15 menit).

### Referensi File
- `bot/main.cjs` atau `ecosystem.config.cjs`
- `bot/scraper.cjs`
```

---

## Issue 3: [Peningkatan] Implementasi Penanganan Error API & Mekanisme Coba Ulang

**Judul:** `[Peningkatan] Tambahkan Coba Ulang Exponential Backoff untuk Batas Laju RPC & API`

**Deskripsi:**
```markdown
### Latar Belakang
Bot sering berinteraksi dengan RPC Solana (untuk transaksi/DLMM) dan API eksternal seperti GMGN dan Jupiter. Saat ini, jika API merespons dengan HTTP 429 (Batas Laju) atau terjadi *timeout* jaringan, bot akan memunculkan *error*, mencatatnya, dan melewati proses tersebut (atau lebih buruknya, *crash*).

### Tujuan
Memastikan ketersediaan dan toleransi kesalahan yang tinggi dengan mengimplementasikan mekanisme coba ulang (*retry*) dengan *exponential backoff*.

### Tugas / Kebutuhan
1. **Buat `api-utils.cjs` (atau pembantu serupa)**: Implementasikan fungsi pembungkus (wrapper) `fetchWithRetry(url, options, maxRetries = 3)` yang menangani kesalahan `429` dan `5xx`.
2. **Strategi Exponential Backoff**: Jika permintaan gagal, tunggu `1 detik`, lalu `2 detik`, lalu `4 detik`, sebelum menyerah.
3. **Coba Ulang Transaksi RPC**: Terapkan logika coba ulang saat berinteraksi dengan SDK `@solana/web3.js` dan `@meteora-ag/dlmm`. Jika `connection.sendTransaction` atau `connection.sendRawTransaction` gagal karena *blockhash* tidak ditemukan atau jaringan padat, ambil ulang *blockhash* terbaru dan coba lagi.

### Referensi File
- `bot/solana-dex.cjs`
- `bot/scraper.cjs`
```

---

## Issue 4: [Peningkatan] Alokasi Modal Dinamis untuk Penyediaan Likuiditas

**Judul:** `[Peningkatan] Dukung Alokasi Modal Dinamis Berbasis Persentase`

**Deskripsi:**
```markdown
### Latar Belakang
Saat ini, modal yang digunakan untuk membuka posisi DLMM baru ditulis langsung (hardcoded) sebagai nilai statis di `user-config.json` -> `meteoraConfig.solAmountToLP` (misalnya, `0.01` SOL). Jika saldo dompet turun di bawah jumlah ini, bot akan gagal mengeksekusi transaksi. Ini merupakan manajemen modal yang buruk.

### Tujuan
Memungkinkan bot menggunakan persentase dari total saldo dompet yang tersedia alih-alih jumlah SOL statis.

### Tugas / Kebutuhan
1. Perbarui `user-config.json` untuk mendukung parameter baru: `meteoraConfig.allocationPercentage` (misalnya, `5` untuk 5%).
2. Di `bot/main.cjs`, sebelum memanggil `addLiquidity()`, ambil total saldo SOL dompet.
3. Hitung jumlah SOL yang akan digunakan: `Jumlah = Total Saldo * (allocationPercentage / 100)`.
4. Tambahkan batasan keamanan: `meteoraConfig.maxSolPerPosition` untuk membatasi pengeluaran maksimum (misalnya, maksimal 1 SOL per posisi terlepas dari persentasenya).
5. Teruskan jumlah SOL dinamis yang dihitung ke `addLiquidity()`.

### Referensi File
- `bot/main.cjs`
- `user-config.json`
```

---

## Issue 5: [Bug/Peningkatan] Kembalikan Dukungan Interaksi Bot Telegram

**Judul:** `[Bug/Peningkatan] Ganti/Perbaiki Polling Telegram untuk Interaksi Dua Arah`

**Deskripsi:**
```markdown
### Latar Belakang
Pustaka `node-telegram-bot-api` saat ini memunculkan `ERR_PACKAGE_PATH_NOT_EXPORTED` karena tidak memiliki pemetaan `exports` CommonJS/ESM standar yang kompatibel dengan pengaturan proyek Node.js saat ini (yang bergantung pada `type: module` untuk `gmgn-cli`). Kami untuk sementara mem-bypass hal ini dengan mengganti pustaka tersebut menggunakan permintaan POST `fetch` manual di `bot/telegram.cjs` hanya untuk mengirim pesan. 

### Tujuan
Mengembalikan kemampuan bot untuk menerima pesan masuk (`/\/chat/` dan `/\/toggle_auto/`) tanpa merusak *runtime* PM2 atau menyebabkan kesalahan resolusi modul.

### Tugas / Kebutuhan
1. **Pustaka Alternatif**: Evaluasi dan ganti `node-telegram-bot-api` dengan pustaka yang lebih modern seperti `telegraf` (yang memiliki dukungan ESM dan TypeScript/Node 18+ yang sangat baik).
2. **Implementasi Ulang Pendengar (Listeners)**:
   - Implementasikan ulang perintah `/toggle_auto` untuk mengalihkan `autoEntryEnabled` di `user-config.json`.
   - Implementasikan ulang perintah `/chat` untuk meneruskan pesan pengguna ke `askAI()` di `bot/ai-agent.cjs`.
3. Pastikan PM2 tidak *crash* saat dijalankan dan *polling* stabil.

### Referensi File
- `bot/telegram.cjs`
- `package.json`
```
