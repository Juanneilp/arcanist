# Arcanist DLMM Bot

Arcanist DLMM Bot adalah bot otomatis untuk jaringan Solana yang melakukan *scraping* token yang sedang tren menggunakan API GMGN, memfilternya berdasarkan fundamental dan analisis teknikal (Supertrend), lalu secara otomatis menyediakan likuiditas satu sisi (Single-Sided Liquidity) menggunakan Meteora DLMM.

## Fitur Utama

- **Scraper Pintar (`bot/scraper.cjs`)**: Mengambil token trending dari GMGN API, memfilter berdasarkan fundamental (Market Cap, Volume, Holders, dll), dan melakukan verifikasi tren *bullish* menggunakan indikator Supertrend.
- **Auto DLMM Meteora (`bot/main.cjs` & `bot/solana-dex.cjs`)**: Menyediakan Single-Sided Liquidity secara otomatis untuk token hasil kurasi dari scraper.
- **Take Profit / Exit via Jupiter (`bot/solana-dex.cjs`)**: Infrastruktur yang dipersiapkan untuk secara otomatis menukar (*swap*) kembali ke SOL setelah mencapai target profit.

## Persyaratan

- Node.js versi 18 ke atas.
- API Key dari GMGN (opsional, public key akan digunakan jika tidak disediakan namun rentan *rate limit*).
- RPC Solana URL.
- Private key wallet.

## Instalasi

1. Clone repositori ini atau masuk ke direktori proyek:
   ```bash
   cd /root/arcanist
   ```
2. Instal dependensi:
   ```bash
   npm install
   ```

## Konfigurasi

### 1. Environment Variables (`.env`)
Salin file `.env.example` ke `.env` dan isi variabel berikut:
```env
WALLET_PRIVATE_KEY=your_base58_private_key_here
RPC_URL=your_solana_rpc_url_here
GMGN_API_KEY=your_gmgn_api_key_here
```

### 2. User Config (`user-config.json`)
Sesuaikan filter *scraping* dan parameter likuiditas di dalam `user-config.json`:
- **`apiSettings`**: Konfigurasi parameter endpoint API GMGN.
- **`localFilters`**: Filter batasan token (contoh: *market cap* minimum, umur minimum).
- **`technicalFilters`**: Pengaturan indikator teknikal seperti periode dan *multiplier* Supertrend.
- **`meteoraConfig`**: Pengaturan untuk aksi bot di Meteora (jumlah SOL yang di-*provide*, tipe strategi, *bin range*).

## Cara Penggunaan

Penggunaan bot ini terbagi ke dalam 2 langkah utama:

**Langkah 1: Scrape Kandidat Token**
Jalankan perintah berikut untuk mengumpulkan kandidat token potensial yang lulus filter fundamental dan indikator tren. Daftar token yang lolos akan disimpan ke file `candidates.json`.
```bash
node scraper.cjs
```

**Langkah 2: Eksekusi DLMM Bot**
Setelah file `candidates.json` dibuat, jalankan bot Meteora untuk melakukan aksi tambah likuiditas secara otomatis.
```bash
node bot.cjs
```
*(Catatan: Mode live execution secara default masih dalam mode komentar/SIMULASI di dalam `bot.cjs` untuk keselamatan selama proses development. Pastikan baris kode eksekusi `addLiquidity` di-uncomment ketika sudah siap produksi.)*

## Disclaimer

Gunakan bot ini dengan bijak dan seluruh risiko perdagangan dan likuiditas (seperti risiko *impermanent loss*) sepenuhnya ditanggung oleh pengguna.
