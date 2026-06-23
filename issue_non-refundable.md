# Laporan Investigasi: Isu "Non-Refundable Cost" pada JAMESON-SOL

## Kesimpulan Eksekutif
**Tidak ada bug pada kode bot Arcanist.** Klaim bahwa transaksi `43hnNDhRLeXyWxU5shWV99s7GKMMCyvSAmUrnquWcxWg` terkena fee *non-refundable* sebesar 0.19 SOL adalah **kesalahan interpretasi (false positive)** dari pembacaan data Solscan. 

Biaya 0.19 SOL yang terpotong dari wallet pengguna **sepenuhnya bersifat REFUNDABLE** (dapat diklaim kembali saat posisi ditutup). Biaya ini merupakan akumulasi dari *Base Position Rent* dan *Position Realloc Cost* (biaya ekstensi memori Solana), BUKAN biaya *BinArray*.

---

## Rincian Analisis Matematis (Membongkar Angka 0.19 SOL)

Pengguna melihat potongan ~0.19 SOL dan berasumsi dengan hitungan:
> *Asumsi Pengguna: 0.059 (Base) + (2 x 0.075 BinArray Kosong) = ~0.209 SOL*

Namun, faktanya, berdasarkan hasil run ulang `dlmmPool.quoteCreatePosition` tepat pada parameter historis saat bot melakukan deploy (Range `minBin: -760`, `maxBin: -521`), berikut adalah rincian tagihan asli dari blockchain Solana:

| Komponen Biaya | Jumlah (SOL) | Sifat Biaya | Penjelasan Teknis |
| --- | --- | --- | --- |
| **Position Rent** | `0.057406 SOL` | **REFUNDABLE** | Biaya dasar sewa memori akun posisi untuk 70 bins pertama (ukuran standar). |
| **Realloc Cost** | `0.132518 SOL` | **REFUNDABLE** | Biaya sewa memori ekstra untuk menampung posisi yang sangat lebar. Total bins yang dicakup bot adalah 239 bins (melebihi standar 70). Solana harus memperbesar ukuran *account space* (Realloc), yang memakan biaya sewa 0.132 SOL. |
| **BinArray Cost** | `0.000000 SOL` | NON-REFUNDABLE | Biaya pembuatan *BinArray* baru. Sesuai log, nilainya murni 0 karena bot hanya bermain di zona BinArray (-11 hingga -8) yang sudah pernah dibuat oleh dev token. |
| **Total Dipotong** | `0.189924 SOL` | **100% REFUNDABLE** | Total SOL yang ditahan oleh smart contract Meteora, yang membulat menjadi **0.19 SOL** di UI Solscan. |

### Mengapa Range-nya Begitu Lebar (239 Bins)?
Di `user-config.json`, konfigurasi range Anda disetel sangat luas: `minRange: -85`, `maxRange: 1`. 
Akibatnya, posisi memanjang dari `Active Bin` ke bawah hingga -85% (sebanyak 239 bin berbeda). Karena 239 jauh melebihi ukuran standar posisi (70 bins), SDK secara otomatis memanggil fungsi `increasePositionLength` (`createExtendedEmptyPosition`), yang memakan memori/rent Solana lebih besar.

---

## Konfirmasi Terhadap Kode `meteora.cjs`

Bot sudah membaca dokumentasi SDK Meteora dengan benar. Kode pada `bot/meteora.cjs` (baris 105 - 145) secara eksplisit mengambil data dari method `quoteCreatePosition`:

```javascript
const binArrayCostSol = toSolValue(quote.binArrayCost);
const binArrayCount = quote.binArrayCount ?? quote.binArraysCount ?? 0;
const positionRentSol = toSolValue(quote.positionRent || quote.positionCost);
const reallocCostSol = toSolValue(quote.reallocCost || quote.positionReallocCost);

// Guard untuk mencegah bayar fee yang hangus (non-refundable)
if (binArrayCount > 0 || binArrayCostSol > 0) {
    return { status: "skipped", reason: "non_refundable_cost" };
}
```

Seperti yang bisa dilihat:
1. Bot memisahkan parameter antara `positionRent` (refundable) dan `binArrayCost` (non-refundable).
2. Bot mendeteksi bahwa `binArrayCost` = 0, sehingga ia mengizinkan transaksi berlanjut (`Safe to deploy!`).
3. Bot tidak pernah mencegah biaya *Refundable* (seperti `reallocCost` sebesar 0.13 SOL) karena biaya ini **akan kembali 100%** ke saldo wallet Anda begitu posisi `/close` dijalankan.

---

## Tindakan Lanjutan untuk Junior Dev / Evaluasi
1. **Tidak ada perbaikan kode yang diperlukan pada mesin bot**. Logika validasi *quoteCreatePosition* sudah akurat mendeteksi dan melewati *non-refundable costs*.
2. **Edukasi UI**: Jika dirasa 0.19 SOL per posisi *refundable* ini terlalu membebani modal yang tertahan (meski bisa ditarik lagi nanti), disarankan untuk mempersempit `minRange` di `user-config.json` (misal diubah dari `-85%` menjadi `-20%`). Semakin sempit range-nya, semakin sedikit jumlah bins yang dicakup, dan `Realloc Cost` (0.13 SOL) akan hilang dengan sendirinya, mengembalikan modal per-posisi ke harga standar (0.059 SOL).
