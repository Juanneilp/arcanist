# Volume Trend Analysis Reference

Dokumen ini menyimpan referensi dan rancangan logika untuk mengimplementasikan *Volume Trend Analysis* dalam pemilihan kandidat token/pool.

## 1. Thesis Utama
- **Volume melambat (Decelerating) cenderung berdampak buruk** pada performa Liquidity Pool, karena volume adalah faktor paling penting dalam menghasilkan fee (yield).
- **Metric yang digunakan**: Persentase perubahan volume (`volume change %`).
- **Kategori Tren**:
  - `Accelerating` (Meningkat)
  - `Stable` (Stabil)
  - `Decelerating` (Melambat)
- **Aksi / Aturan Filter**: Token atau pool dengan tren volume **Decelerating** memiliki risiko *catastrophic losses* dan harus **di-skip (ditolak)**.

---

## 2. Pendekatan 1: Menggunakan Data GMGN AI (K-Line)
Karena kita sudah menggunakan GMGN AI (`fetchKlineData`) untuk indikator Supertrend, kita bisa memanfaatkan data volume historis dari K-Line (candlesticks).

### Logika Kalkulasi:
1. Ambil array K-Line (misalnya timeframe 15m atau 1h).
2. Tentukan periode `N` (misal 3-5 candle terakhir).
3. Hitung rata-rata volume saat ini (`Recent Volume Avg` dari `N` candle terakhir).
4. Hitung rata-rata volume sebelumnya (`Previous Volume Avg` dari `N` candle sebelum periode recent).
5. Hitung persentase perubahannya:
   ```
   Volume Change % = ((Recent Volume Avg - Previous Volume Avg) / Previous Volume Avg) * 100
   ```

### Threshold Kategori (Contoh Default):
- **Accelerating**: `Volume Change % > +10%`
- **Stable**: `-10% <= Volume Change % <= +10%`
- **Decelerating**: `Volume Change % < -10%`

*(Catatan: Ambang batas ini dapat disesuaikan pada file `user-config.json` di bawah `technicalFilters.volumeTrend`).*

---

## 3. Pendekatan 2: Menggunakan Meteora API (Multi-Timeframe)
Berdasarkan konsultasi dengan referensi Meteora SDK/API, mereka menyediakan data volume multi-timeframe langsung pada respons list pool. Ini dapat mempermudah proses karena tidak memerlukan agregasi K-Line manual.

### Ketersediaan Data:
Pada endpoint `GET /pools`, respons JSON sudah menyediakan field seperti `volume.1h`, `volume.4h`, `volume.12h`, `volume.24h`.

### Logika Kalkulasi:
1. Ambil data volume pada timeframe yang berdekatan/berurutan.
2. Bandingkan timeframe pendek dengan timeframe yang lebih panjang secara proporsional.
   *Contoh perbandingan (1h vs rata-rata 1h dari 4h terakhir)*:
   - `volume_recent` = `volume.1h`
   - `volume_older_avg` = (`volume.4h` - `volume.1h`) / 3
   - Ataupun membandingkan secara langsung antara blok waktu yang berbeda jika ditarik dari history (`GET /pools/{address}/volume/history`).

Rumus perubahan:
```
volume_change = (volume_recent - volume_older) / volume_older * 100
```

### Threshold Kategori:
- **Accelerating**: `volume_change > threshold`
- **Stable**: `volume_change ≈ 0` (di antara batas atas dan batas bawah threshold)
- **Decelerating**: `volume_change < -threshold` -> **Filter Out / Skip**

## Kesimpulan Implementasi
Kita dapat menerapkan salah satu (atau gabungan) dari kedua data source di atas:
- **GMGN AI**: Cocok diterapkan di sisi Scraper / Token Discovery sebelum token masuk ke fase likuiditas.
- **Meteora API**: Cocok diterapkan di sisi pemantauan Pool secara real-time untuk mengevaluasi apakah posisi LP sebaiknya dipertahankan atau ditarik ketika volume sudah mulai `Decelerating`.
