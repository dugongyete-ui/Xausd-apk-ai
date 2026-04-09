# LIBARTIN Backtest — Prompt Perbaikan Kedepan

Kirim prompt di bawah satu per satu ke chat AI secara berurutan.
Tunggu setiap perbaikan selesai dan ditest sebelum lanjut ke prompt berikutnya.

---

## PROMPT 1 — Perbaikan Kualitas Sinyal

```
Beberapa sinyal di backtest memiliki RR1 < 1:1 (TP1 lebih dekat dari SL),
yang tidak ideal secara manajemen risiko. Bantu perbaiki strategi di scripts/backtest.ts
dan server/derivService.ts:

1. Revisi formula TP1: TP1 seharusnya minimal 1:1 RR dari entry.
   - Saat ini: tp1 = Math.min/max(fibLevel, atrLevel) → bisa lebih kecil dari 1R
   - Perbaiki: tp1 = entryPrice + slDistance * 1.0 (bullish) / entryPrice - slDistance * 1.0 (bearish)
   - Pastikan TP1 tidak melewati TP2

2. Tambah filter "zone confluence": sinyal lebih valid jika entry zone (61.8%–78.6% fib)
   juga bertepatan dengan:
   - Round number (harga mendekati angka bulat ±2 poin, mis. 4700, 4750, 4800)
   - Previous swing high/low dalam radius 3 poin
   - Jika confluence terdeteksi, tandai sinyal dengan tag "confluence: true"

3. Tambah filter body candle M5:
   - Jika body candle M5 < 30% dari full range (high-low), abaikan sinyal
   - Ini filter candle doji/indecision yang tidak punya momentum

4. Terapkan semua perubahan di KEDUA file: scripts/backtest.ts DAN server/derivService.ts

Target files: scripts/backtest.ts, server/derivService.ts
```

---

## PROMPT 2 — Perbesar Sampel & Validasi Statistik

```
Backtest saat ini hanya menggunakan 1 hari data (default). Bantu perbaiki scripts/backtest.ts
untuk hal-hal berikut:

1. Ubah default window dari 1 hari ke 7 hari agar sampel lebih representatif.
   - Perlu handle limit API Deriv: max 5000 candle per request. Jika candle > limit,
     bagi ke beberapa request dan gabungkan hasilnya.
   - Tambah opsi CLI --days=N dengan max 30 hari.

2. Tambah uji signifikansi statistik sederhana di summary:
   - Hitung confidence interval winrate (Wilson score interval 95%)
   - Tampilkan: "Winrate: 75% [CI: 62%–85%]" agar kita tahu apakah hasilnya signifikan
   - Jika total resolved < 20 sinyal, tampilkan peringatan "⚠ Sampel terlalu kecil"

3. Tambah kolom "Max Adverse Excursion (MAE)" per sinyal:
   - Seberapa dalam harga bergerak melawan posisi sebelum akhirnya menang
   - Berguna untuk evaluasi apakah SL terlalu ketat

Target file: scripts/backtest.ts
```

---

## PROMPT 3 — Deteksi Regime Pasar (Trending vs Sideways)

```
Strategi Fib retracement bekerja lebih baik di pasar yang trending.
Tambahkan deteksi regime pasar di scripts/backtest.ts dan server/derivService.ts:

1. Buat fungsi detectMarketRegime(m15Candles: Candle[]): "trending" | "ranging" | "unknown"
   - Gunakan ADX (Average Directional Index) periode 14 pada M15:
     - ADX > 25 → trending
     - ADX < 20 → ranging
     - Di antara 20-25 → unknown
   - Implementasikan ADX dari scratch (tidak perlu library eksternal)

2. Di backtest loop: hanya generate sinyal jika regime === "trending"
   - Tambah tag "regime" ke BacktestSignal interface
   - Di summary, tampilkan breakdown winrate per regime

3. Di derivService.ts: tambah field marketRegime ke TradingSignal,
   tampilkan di UI sebagai info tambahan

4. Analisis di summary: apakah sinyal di regime "trending" punya winrate lebih tinggi
   dibanding "ranging"? Ini validasi penting apakah filter ADX worth it.

Target files: scripts/backtest.ts, server/derivService.ts, TradingContext.tsx
```

---

## PROMPT 4 — Simpan Hasil ke JSON & Analisis Mendalam

```
Tambahkan fitur export hasil backtest ke file JSON di scripts/backtest.ts:

1. Setelah simulasi selesai, simpan semua sinyal ke file:
   scripts/results/backtest_YYYYMMDD_HHmm.json
   Format: { metadata: { period, days, totalSignals, winrate, ev }, signals: [...] }

2. Buat script terpisah scripts/analyze.ts yang membaca file JSON hasil backtest dan menampilkan:
   - Distribusi RR2 per sinyal (histogram sederhana di terminal)
   - Streaks: win streak terpanjang, loss streak terpanjang
   - Performa per hari dalam seminggu (Senin, Selasa, dst.)
   - Performa per jam UTC (08:00, 09:00, ... 21:00)
   - Monte Carlo simulasi 1000x dengan sampel acak untuk estimasi drawdown

3. Tambah opsi --save ke backtest CLI:
   npx tsx scripts/backtest.ts --days=7 --save

Target files: scripts/backtest.ts, scripts/analyze.ts
```

---

## PROMPT 5 — Walk-Forward Validation (Anti-Overfitting)

```
Backtest biasa rentan overfitting. Bantu tambahkan walk-forward validation
di scripts/backtest.ts:

1. Tambah mode --walk-forward ke CLI:
   npx tsx scripts/backtest.ts --days=30 --walk-forward

2. Cara kerja walk-forward:
   - Bagi 30 hari data menjadi 6 blok @ 5 hari
   - Untuk setiap blok: gunakan blok sebelumnya sebagai konteks (in-sample),
     blok saat ini sebagai pengujian (out-of-sample)
   - Tampilkan winrate per blok (blok 1, 2, 3, 4, 5, 6) untuk lihat apakah konsisten atau degradasi

3. Di summary walk-forward, tampilkan:
   - Winrate per periode 5 hari
   - Standard deviation winrate antar periode (semakin kecil = semakin stabil)
   - Apakah ada degradasi performa dari blok awal ke blok akhir (tanda overfitting)

4. Gunakan parallel WebSocket requests untuk efisiensi fetch data multi-periode:
   Fetch semua blok M5 data secara bersamaan (Promise.all)

Target file: scripts/backtest.ts
```

---

## Cara Pakai

1. Copy isi PROMPT 1 (teks di dalam blok kode)
2. Tempel ke chat AI
3. Tunggu selesai dan ditest
4. Lanjut ke PROMPT 2, dst.

Jangan loncat urutan — setiap prompt bergantung pada perbaikan sebelumnya.
