# LIBARTIN — Fibonacci XAUUSD Trading Analysis App

## Overview
LIBARTIN adalah aplikasi analisis trading mobile profesional berbasis Expo (React Native) yang dirancang untuk analisis Fibonacci retracement real-time pada XAUUSD (Gold/USD). Menggunakan data live dari Deriv WebSocket untuk menghasilkan keputusan trading murni matematis, menghilangkan asumsi visual subjektif. Strategi inti adalah "Deep Pullback Continuation" yang fokus pada M15 untuk struktur pasar (EMA, swing detection, Fibonacci) dan M5 untuk konfirmasi entry.

## User Preferences
Iterative development dengan komunikasi jelas pada perubahan signifikan. Sebelum perubahan arsitektur besar atau dependensi baru, minta approval. Untuk perubahan kecil, lanjutkan dan informasikan. Pastikan semua penjelasan ringkas dan langsung relevan. Kode terstruktur dengan baik dan mengikuti best practices.

## System Architecture

### Frontend (Expo / React Native)
- **Framework**: Expo Router untuk file-based navigation.
- **State Management**: React Context (`TradingContext`) untuk semua trading engine state.
- **Styling**: Dark navy trading terminal theme (`#0A0E17` background, `#F0B429` gold accent), Inter untuk UI, Orbitron untuk branding.
- **Navigation**: 4-tab layout — Dashboard, Signals (Riwayat Sinyal), AI Chat, Settings.
- **Components**: `FibChart.tsx` untuk candlestick chart interaktif dengan Fibonacci levels, EMA lines, dan signal markers.
- **Features**: Live price display, trend indicators, Fibonacci level visualization, active signal tracking, signal history, configurable risk parameters.
- **Offline Capabilities**: Mensimulasikan candle yang hilang via seeded random walk dan generate sinyal selama periode offline panjang, menyimpan outcome ke history.

### Backend (Express — berjalan 24/7)
- **Server**: Port 5000, melayani landing page dan static Expo assets.
- **DerivService** (`server/derivService.ts`): Koneksi WebSocket persisten ke Deriv yang berjalan 24/7. Menangani streaming data, analisis, dan deteksi sinyal secara terus-menerus — bahkan saat HP mati/tidak ada internet di sisi user.
- **APIs**: `GET /api/market-state`, `GET /api/signals`, `GET /api/health`.
- **Push Notifications**: Backend mengirim Expo Push Notifications ke HP saat sinyal baru, TP hit, atau SL hit — tanpa perlu app aktif.
- **AI Integration** (`server/aiService.ts`): AI chat service dengan contextual memory. Auto-generate rekomendasi saat sinyal BUY/SELL terdeteksi dan komentar saat TP/SL tercapai. Arsitektur fire-and-poll: `POST /api/ai/chat` langsung return (queue background), frontend poll `GET /api/ai/messages` tiap 2 detik sampai respons muncul.

### Konsep Utama: Sinyal Tanpa HP Aktif
Backend server berjalan terus di cloud. Ketika HP user offline 1 hari penuh, server tetap:
1. Memantau harga XAUUSD real-time via Deriv WebSocket
2. Mendeteksi setup sinyal valid (Golden Zone + EMA + candlestick pattern)
3. Menyimpan sinyal yang terdeteksi ke signal history
4. Mengirim push notification ke HP user (muncul di notifikasi HP)
Ketika HP dibuka kembali, app mengambil signal history dari backend — sudah ada sinyal yang ter-generate selama offline.

### Trading Strategy: Deep Pullback Continuation (Pure Fibonacci Scalping)

#### EMA yang Digunakan (2 periode):
- **EMA 20** (M5): Konfirmasi entry — EMA20 > EMA50 = Bullish confirmation, EMA20 < EMA50 = Bearish confirmation
- **EMA 50** (M15 & M5): Trend M15 (struktur) — Price > EMA50 = Bullish, Price < EMA50 = Bearish; + konfirmasi alignment M5
- **EMA 200 DIHAPUS** — tidak digunakan lagi. Strategi scalping fokus pada EMA50 + Fibonacci bi-directional.

#### Alur Deteksi Sinyal:
1. **Trend M15**: Posisi harga relatif EMA50 (harga > EMA50 = Bullish, harga < EMA50 = Bearish)
2. **Swing Detection**: Fractal 5-bar hybrid pada M15 untuk anchor Fibonacci
3. **Fibonacci Levels**: Swing High & Low → hitung 61.8%, 78.6%, extension -27%
4. **Golden Zone**: Harga masuk zona 61.8%–78.6% (zona entry utama)
5. **Konfirmasi M5** (TIGA syarat wajib):
   - Harga dalam Golden Zone
   - Pola candlestick: Pin Bar Rejection atau Engulfing pada M5
   - EMA alignment M5: EMA20 > EMA50 (Bullish) atau EMA20 < EMA50 (Bearish)
6. **Entry**: Harga close candle M5 konfirmasi
7. **SL**: Di bawah Swing Low (Bullish) atau di atas Swing High (Bearish)
8. **TP1**: RR 1:1, maksimal 15 poin dari entry (scalping cepat)
9. **TP2**: Fibonacci extension -27% atau RR 1:1.8, cap 28 poin (full target)

### Data Management & Persistence
- **Caching**: M15 dan M5 candles di-cache ke AsyncStorage untuk startup cepat.
- **Persistence**: Signal history dan account balance di AsyncStorage.
- **Market Hours**: `forexMarketOpen()` cek UTC time untuk XAUUSD open/close.

### AI System (LIBARTIN AI)
- **Provider**: Pollinations AI (OpenAI-based, `text.pollinations.ai`)
- **System Prompt**: Sinkron penuh dengan strategi — menyebutkan EMA20/EMA50 M5 sebagai syarat konfirmasi entry, selain EMA50/EMA200 M15 untuk trend.
- **Context**: Setiap pesan ke AI dilengkapi data real-time: harga, trend M15, EMA50/EMA200 M15, EMA20/EMA50 M5 (beserta alignment status), Fibonacci levels, status Golden Zone, dan sinyal aktif.
- **Auto-commentary**: Auto-generate analisis saat sinyal baru terdeteksi dan saat TP/SL tercapai.
- **Chat history**: 6 turn terakhir (12 message) disimpan dalam memori untuk konteks percakapan.
- **Streaming**: Word-by-word streaming simulation dari respons penuh.

### Notification System
- **Real-time** (app aktif): Local notifications saat app terbuka.
- **Background/Closed**: Backend kirim Expo Push Notifications untuk sinyal, TP, SL.
- **Background Fetch**: `expo-background-fetch` + `expo-task-manager` untuk periodic background wakeup.

## External Dependencies
- **Deriv WebSocket API**: `wss://ws.derivws.com/websockets/v3?app_id=114791` — live XAUUSD data
- **Pollinations AI**: `https://text.pollinations.ai/v1/chat/completions` — AI chat (no API key required)
- **Expo Ecosystem**: `expo`, `expo-router`, `expo-blur`, `expo-haptics`, `expo-glass-effect`, `expo-background-fetch`, `expo-task-manager`, `expo-notifications`, fonts (Inter, Orbitron)
- **React Native Libraries**: `@tanstack/react-query`, `@react-native-async-storage/async-storage`, `react-native-reanimated`, `react-native-safe-area-context`, `react-native-keyboard-controller`, `react-native-gesture-handler`, `react-native-svg`

## Key Files
- `server/derivService.ts` — Core background market analysis engine, WebSocket, signal detection
- `server/aiService.ts` — AI prompt engineering, market context builder, chat service
- `server/routes.ts` — Express API routes
- `contexts/TradingContext.tsx` — Frontend state management, offline simulation, EMA calculations
- `components/FibChart.tsx` — Custom SVG-based financial charting (candlestick + EMA + Fibonacci)
- `components/AIAdvisor.tsx` — AI Chat UI component
- `app/(tabs)/_layout.tsx` — Main navigation tab structure
- `app/(tabs)/index.tsx` — Dashboard tab
- `app/(tabs)/signals.tsx` — Signal history tab
- `app/(tabs)/ai.tsx` — AI Chat tab
- `app/(tabs)/settings.tsx` — Settings tab

## Recent Changes

- **2026-03-06 v3**: Bug fix — sinyal aktif tidak tampil di dashboard + sinkronisasi install script:
  - **Fix activeSignal tidak tampil**: `activeSignal` kini di-restore dari sinyal pending terbaru di history saat startup (dari cache lokal maupun dari server). Sebelumnya, efek `setActiveSignal(null)` yang dipicu perubahan `currentAnchorEpoch` menghapus sinyal sebelum sempat tampil.
  - **Fix anchor-change effect**: Efek yang memantau `currentAnchorEpoch` tidak lagi langsung menghapus `activeSignal`. Sinyal pending dipertahankan sampai TP/SL benar-benar tercapai. Hanya sinyal yang sudah resolved (win/loss) yang dihapus.
  - **Restore dari server signals**: Saat periodic sync (tiap 3 menit) menemukan sinyal baru dari server, `activeSignal` juga di-restore jika belum ada yang aktif.
  - **Fix esbuild missing**: Tambah `esbuild` ke `devDependencies` di `package.json` (digunakan di `npm run server:build` tapi sebelumnya tidak terdaftar).
  - **Update install script**: `scripts/install-deps.sh` kini punya section `[ DEV ]` untuk verifikasi dev dependencies, termasuk `esbuild`.


- **2026-03-05 v2**: Bi-directional scalping + chart cleanup:
  - **Hapus -27% Extension (Take Profit)** dari `FibChart.tsx` — label sudah digantikan TP1/TP2 di sinyal aktif
  - **Bi-directional swing detection**: `findSwings()` di `derivService.ts` dan `TradingContext.tsx` kini mencari impulse wave terbaru di KEDUA arah (bullish & bearish) tanpa syarat EMA alignment. Sistem memilih impulse paling baru berdasarkan anchorEpoch. Ini memungkinkan sinyal BUY bahkan saat EMA M15 masih bearish, selama impulse naik terbaru sudah terbentuk (new L → new H).
  - **fibTrend state**: Ditambahkan `fibTrend: "Bullish" | "Bearish" | null` ke TradingContext dan FibChart. Chart Fibonacci sekarang mengikuti arah impulse aktual, bukan EMA trend yang lagging.
  - **Offline simulator** diperbarui untuk pakai `findSwings()` tanpa parameter trend.
  - **EMA trend badge** (BEARISH/BULLISH di dashboard) tetap berdasarkan EMA50 vs EMA200 M15 untuk referensi trend makro.

- **2026-03-05 v1**: Sinkronisasi sistem AI:
  - Ditambahkan `ema20m5` dan `ema50m5` ke `MarketStateSnapshot` interface di `server/derivService.ts`
  - Ditambahkan `EMA20_PERIOD = 20` konstanta di server
  - `getSnapshot()` kini menghitung EMA20 dan EMA50 dari M5 candles secara real-time
  - `buildMarketContext()` di `aiService.ts` kini mengirim data EMA20/EMA50 M5 + alignment status ke AI
  - System prompt diperbarui: 3 syarat konfirmasi entry M5 sekarang eksplisit (Golden Zone + candlestick pattern + EMA20/EMA50 alignment)
