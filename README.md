# Arcanist DLMM Bot

Arcanist DLMM Bot adalah bot otomatis (Automated Trading & LP Bot) kelas atas untuk ekosistem Solana. Bot ini dirancang untuk mendeteksi token *trending*, menyaringnya melalui analisis fundamental & teknikal (Supertrend), menyeleksinya menggunakan **Hermes AI Agent**, dan secara dinamis menyediakan likuiditas satu sisi (*Single-Sided Liquidity*) menggunakan pool **Meteora DLMM**.

## 🚀 Fitur Utama Terkini

- **AI-Powered Screening (`bot/ai-agent.cjs`)**: Terintegrasi dengan model LLM (Bluesminds) untuk memberikan analisis tambahan pada kandidat token, memilih token terbaik dengan rasio aman.
- **Advanced GMGN Scraper (`bot/scraper.cjs`)**: Mengambil data secara *real-time* dan memfilternya berdasarkan Metrik Fundamental (*Market Cap*, Volume, Umur Token, *Smart Degen Holders*) dan Teknikal (Supertrend *Bullish*).
- **Dynamic Capital Allocation (`bot/main.cjs`)**: Manajemen risiko otomatis dengan menghitung alokasi modal dinamis berdasarkan sisa saldo dompet, dengan mempertimbangkan *Gas Reserve*, *Refundable Reserve*, dan *Maximum Allocation*.
- **Comprehensive Exit Strategy (`bot/main.cjs`)**: Secara pintar akan mencairkan dan menutup posisi DLMM berdasarkan:
  - Take Profit (TP) & Stop Loss (SL).
  - Batas waktu maksimal posisi (*Timeout*).
  - Sinyal Teknikal Gabungan (RSI *Overbought*, penembusan *Bollinger Bands*, dan *MACD Histogram*).
- **Auto Dust Sweeper (`bot/solana-dex.cjs`)**: Menukarkan sisa *dust* token yang nilainya di atas limit kembali ke SOL melalui Jupiter API pasca penutupan likuiditas.
- **Otomatisasi Cron Job**: Scraper dan laporan pemantauan berjalan sepenuhnya di latar belakang dengan interval dinamis (tidak perlu eksekusi manual berulang).
- **Telegram Bot Control (`bot/telegram.cjs`)**: Terhubung dengan Telegram menggunakan `telegraf` untuk mengirim pembaruan secara *real-time*, memantau `/positions`, menghidupkan/mematikan bot (`/toggle_auto`), dan mengobrol langsung dengan AI Analis (`/chat`).
- **Resilient API Handling (`bot/api-utils.cjs`)**: Mekanisme *Exponential Backoff* untuk menangani transaksi RPC atau API yang gagal karena *rate limit* atau gangguan jaringan.

## ⚙️ Persyaratan Sistem

- **Node.js** v18 atau lebih baru.
- **API Key** dari GMGN (opsional, tetapi sangat direkomendasikan agar terhindar dari batas laju / *rate limit*).
- **Telegram Bot Token** & Chat ID (dari @BotFather).
- **Solana RPC URL** yang stabil.
- **Private Key** Dompet Solana.

## 🛠️ Instalasi

1. Clone repositori ini dan masuk ke direktori proyek:
   ```bash
   git clone https://github.com/Juanneilp/arcanist.git
   cd arcanist
   ```
2. Instal semua dependensi:
   ```bash
   npm install
   ```

## 📝 Konfigurasi

### 1. Environment Variables (`.env`)
Salin file `.env.example` ke `.env` dan konfigurasikan kunci rahasia Anda:
```env
WALLET_PRIVATE_KEY=your_base58_private_key_here
RPC_URL=your_solana_rpc_url_here
GMGN_API_KEY=your_gmgn_api_key_here
TELEGRAM_BOT_TOKEN=your_telegram_token
TELEGRAM_CHAT_ID=your_chat_id
BLUESMINDS_API_KEY=your_bluesminds_api_key
```

### 2. User Configuration (`user-config.json`)
Pusat kendali bot Anda berada di `user-config.json`:
- **`botMode`**: Atur ke `"dry_run"` untuk simulasi atau `"live"` untuk eksekusi nyata menggunakan uang sungguhan.
- **`meteoraConfig`**: Pengaturan modal dinamis (`maxSolPerPosition`, `minSolToOpen`, `gasReserve`, `refundableReserve`) serta strategi Bin Meteora.
- **`monitoringConfig`**: Interval perulangan cron, batas posisi maksimal, dan mode entri/penutupan otomatis.
- **`exitConfig`**: Persentase TP/SL, durasi *hold* maksimal, dan parameter indikator (RSI, BB, MACD).

## ▶️ Menjalankan Bot

Proyek ini telah digabungkan menjadi satu kesatuan alur kerja (*unified workflow*). Scraper dan eksekutor utama dikontrol dalam satu proses berjalan.

Mulai Arcanist Bot dengan menjalankan:
```bash
node bot/main.cjs
```
Atau menggunakan PM2 agar berjalan di *background*:
```bash
pm2 start bot/main.cjs --name "arcanist"
```

## ⚠️ Disclaimer
Gunakan perangkat lunak ini dengan hati-hati. *Trading* kripto dan penyediaan likuiditas memiliki risiko yang sangat tinggi (terutama *Impermanent Loss* dan *Rug Pull* pada aset koin *meme*). Seluruh kerugian finansial sepenuhnya ditanggung oleh pengguna.
