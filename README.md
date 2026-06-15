# Arcanist DLMM Bot

**Arcanist DLMM Bot** adalah sistem otomatis tingkat lanjut (*Automated Trading & LP Bot*) yang dirancang khusus untuk ekosistem Solana. Bot ini menggabungkan pencarian data *real-time*, analisis teknikal, dan kecerdasan buatan (AI) untuk menemukan token berpotensi tinggi, mengeksekusi penyediaan likuiditas pada pool **Meteora DLMM**, dan mengelola risiko secara otonom.

## 🚀 Fitur Unggulan

- **🧠 Hermes AI-Powered Selection**: Terintegrasi dengan model LLM canggih (mendukung berbagai *provider* seperti Bluesminds, OpenRouter, Claude, OpenAI, dll.) yang bertindak sebagai analis kripto elit. AI ini menyaring kandidat token berdasarkan fundamental dan metrik teknikal untuk memastikan hanya token terbaik yang dieksekusi.
- **📊 Advanced GMGN Scraper & Filter**: Secara otomatis mendeteksi token baru (terutama dari Pump.fun) melalui API GMGN. Dilengkapi dengan filter ketat seperti *Market Cap*, Volume 24 jam, rasio *Smart Degen Holders*, umur token, serta filter keamanan transaksi (*not wash trading*, *has social*, *burn*).
- **📉 Eksekusi Berbasis Analisis Teknikal**: Memanfaatkan indikator **Supertrend** untuk mendeteksi momentum *bullish* sebagai sinyal masuk, serta kombinasi **RSI**, **Bollinger Bands**, dan **MACD** untuk menentukan titik keluar (exit) yang optimal.
- **💧 Meteora DLMM Integration & Zap Out Logic**: Menjalankan strategi penyediaan likuiditas secara otomatis pada Meteora DLMM dengan rentang *bin* yang dapat disesuaikan. Mendukung fitur **Zap Out** mutakhir untuk penutupan posisi secara cepat dan efisien.
- **🛡️ Smart Risk & Capital Management**: Manajemen alokasi modal dan risiko yang presisi. Fitur ini mencakup alokasi spesifik per posisi, perlindungan saldo melalui *Gas Reserve* dan *Refundable Reserve*, serta parameter **Take Profit (TP)** dan **Stop Loss (SL)** otomatis.
- **🧹 Auto Dust Sweeper**: Algoritma cerdas yang mendeteksi dan menukarkan sisa *dust* token (di atas batas limit tertentu) kembali menjadi SOL secara otomatis melalui Jupiter API pasca penutupan likuiditas.
- **📱 Telegram Command Center**: Kendali penuh di ujung jari Anda. Pantau portofolio, cek posisi aktif, ubah mode bot (Auto/Manual), hingga berkonsultasi langsung dengan AI Analis langsung dari Telegram.

## 🧰 Tech Stack, SDKs & APIs

Proyek ini dibangun di atas infrastruktur Web3 dan AI modern untuk memastikan kecepatan, keamanan, dan keandalan tinggi. Berikut adalah teknologi, SDK, dan API utama yang menopang bot ini:

### 🧩 SDK & Libraries
- **`@solana/web3.js`**: SDK inti (*core library*) untuk berinteraksi dengan jaringan *blockchain* Solana, mencakup pembacaan *state*, hingga eksekusi transaksi melalui RPC.
- **`@meteora-ag/dlmm`**: SDK resmi dari Meteora untuk berinteraksi langsung dengan kontrak pintar (*smart contract*) Dynamic Liquidity Market Maker (DLMM).
- **`@meteora-ag/zap-sdk`**: Ekstensi SDK Meteora yang dirancang khusus untuk memfasilitasi fitur *Zap Out*, yaitu proses pencairan *Liquidity Pool* (LP) kembali ke satu aset tunggal (seperti SOL) secara efisien tanpa banyak langkah transaksi.
- **`@coral-xyz/anchor`**: *Framework* Solana standar industri yang digunakan (bersama SDK Meteora) untuk melakukan serialisasi/deserialisasi instruksi transaksi dan struktur akun kompleks di atas jaringan Solana.
- **`telegraf`**: *Framework* Node.js mutakhir yang digunakan untuk membangun dan mengelola *bot* Telegram, menangani perintah jarak jauh (remote command), dan mengirimkan notifikasi *real-time*.

### 🔌 External APIs
- **GMGN API**: Penyedia data *on-chain* *real-time* berkinerja tinggi. Digunakan untuk proses pelacakan (*scraping*), penyaringan (*filtering*) koin di Pump.fun, dan analisis metrik *Smart Degen*.
- **Jupiter API (V6/V1)**: Agregator bursa terdesentralisasi (DEX) terkemuka di Solana. Digunakan secara eksklusif oleh fitur *Auto Dust Sweeper* untuk mencari *routing* penukaran sisa koin menjadi SOL dengan *slippage* terbaik.
- **AI Provider API**: Mendukung koneksi fleksibel ke berbagai penyedia layanan *Large Language Model* (LLM) seperti Bluesminds, OpenRouter, Claude, atau OpenAI. LLM ini menjadi otak dari **Hermes AI Agent** dalam mengeksekusi analisis fundamental lanjutan.

## ⚙️ Persyaratan Sistem

- **Node.js**: Versi 18 atau lebih baru.
- **Solana RPC URL**: Endpoint RPC Solana yang stabil dan cepat.
- **Private Key Wallet**: Kunci privat dompet Solana (format Base58).
- **API Keys**:
  - GMGN API Key (Sangat direkomendasikan untuk menghindari *rate limit*).
  - AI Provider API Key (Bluesminds, OpenRouter, Anthropic/Claude, dll. untuk fitur AI Agent).
  - Telegram Bot Token & Chat ID (Untuk notifikasi dan kontrol via Telegram).

## 🛠️ Panduan Instalasi

1. **Clone repositori** ini dan masuk ke dalam direktori proyek:
   ```bash
   git clone https://github.com/Juanneilp/arcanist.git
   cd arcanist
   ```

2. **Instal dependensi** yang dibutuhkan:
   ```bash
   npm install
   ```

## 📝 Konfigurasi

Bot ini sangat fleksibel dan dapat dikonfigurasi melalui dua file utama:

### 1. Variabel Lingkungan (`.env`)
Salin file `.env.example` menjadi `.env` dan masukkan seluruh kunci rahasia serta API Key Anda:
```env
WALLET_PRIVATE_KEY=your_base58_private_key_here
RPC_URL=your_solana_rpc_url_here
GMGN_API_KEY=your_gmgn_api_key_here
TELEGRAM_BOT_TOKEN=your_telegram_token
TELEGRAM_CHAT_ID=your_chat_id
AI_API_KEY=your_ai_api_key_here # Tergantung provider yang Anda pilih (Bluesminds, OpenRouter, dll)
```

### 2. Konfigurasi Pengguna (`user-config.json`)
File ini mengontrol seluruh parameter *trading*, strategi, dan manajemen risiko:
- **`botMode`**: Set ke `"live"` untuk eksekusi nyata, atau `"dry_run"` untuk simulasi (*paper trading*).
- **`localFilters` & `apiSettings`**: Parameter filter koin seperti *Market Cap* minimum, volume, umur token, dll.
- **`meteoraConfig`**: Strategi likuiditas Meteora, ukuran *bin*, alokasi SOL (`solPerPosition`), dan pencadangan *gas fee*.
- **`exitConfig`**: Kondisi penutupan posisi (TP/SL, *max hold time*, dan sinyal *Technical Analysis*).
- **`monitoringConfig`**: Interval perulangan cron untuk scraper dan monitor posisi, serta mode entri (*auto* atau *manual*).

## ▶️ Menjalankan Bot

Sistem Arcanist dirancang dengan *unified workflow* di mana proses *scraping*, eksekusi, dan pemantauan berjalan secara sinkron.

Untuk menjalankan bot secara langsung:
```bash
node bot/main.cjs
```

Untuk menjalankan di *background* menggunakan PM2 (Direkomendasikan untuk *server* / VPS):
```bash
pm2 start bot/main.cjs --name "arcanist"
```

## ⚠️ Disclaimer

Penggunaan *software* ini sepenuhnya merupakan tanggung jawab pengguna. Perdagangan aset kripto dan penyediaan likuiditas (terutama *meme coins*) memiliki risiko finansial yang sangat tinggi, termasuk risiko **Impermanent Loss** dan manipulasi pasar (*Rug Pull*). Selalu lakukan riset Anda sendiri (*Do Your Own Research*) dan gunakan modal yang siap Anda hilangkan.
