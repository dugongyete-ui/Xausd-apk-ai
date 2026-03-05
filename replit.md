# LIBARTIN — Fibonacci XAUUSD Trading Analysis App

## Project Overview
A professional mobile trading analysis app built with Expo (React Native) that performs real-time Fibonacci retracement analysis on XAUUSD (Gold/USD) using live data from Deriv WebSocket. All trading decisions are purely mathematical — no random, no visual assumptions.

## Recent Changes (2026-03-05)
- **AI fixed — 60s timeout + retry**: `callPollinationsAI` now uses 60s timeout (was 35s) and retries once on HTTP error, empty content, or parse failure. Added `User-Agent` + `Accept` headers to prevent Cloudflare 502 errors. Falls back to `reasoning_content` if `content` field is empty.
- **BUY/SELL badge always visible**: Chart now shows badge for `activeSignal` as a fallback when `currentSignal` is null (e.g. during cooldown). Entry/SL/TP lines also persist via `activeSignal`.
- **Offline signal generation**: On app startup, if device was offline for >10 minutes, the app simulates the missing candles using a seeded random walk (LCG + Box-Muller, based on historical ATR). Full Fibonacci+EMA signal detection runs on the simulated data, and TP/SL outcomes are determined. Signals are saved to history with win/lose status. Key: `fibo_last_online_v1`.
- **AI Chat input bar fixed**: Was hidden behind the absolute-positioned tab bar. Fixed by adding explicit `paddingBottom = tabBarHeight + insets.bottom` to the root View.
- **Hint chips made tappable**: EmptyState hint chips now use `Pressable` — tapping fills the TextInput and focuses keyboard.
- **TP calculation made realistic for scalping**: Formula now uses `floor = max(m5ATR × 2.0, 8pts)` and `cap = max(m5ATR × 4.0, 20pts)`. Fibonacci extension used as target if it falls in range. Applied in both frontend (`TradingContext.tsx`) and backend (`derivService.ts`).
- **Fibonacci responsiveness improved**: Frontend `findSwings()` changed from 5-bar fractal (required 2 confirmed candles after anchor) to 3-bar fractal (1 confirmed candle). Also removed `PAIR_LOOKBACK=25` limit — now searches full window for pair extremes. This matches the already-fast server implementation and cuts detection delay by one M15 candle (15 minutes faster).

## Strategy: Deep Pullback Continuation
- **Analysis Timeframe**: M15 (structure, EMA, swing detection, Fibonacci)
- **Execution Timeframe**: M5 (entry confirmation — rejection or engulfing)
- **Golden Zone**: 61.8%–78.6% retracement
- **Target**: -27% Extension beyond swing extreme
- **Fibonacci Structure**:
  - 0.0% = Swing High (Resistance) for Bullish / Swing Low (Support) for Bearish
  - 61.8% = Golden Retracement Level (Primary Entry Zone)
  - 78.6% = Deep Retracement Level (Final Defense Zone)
  - 100% = Swing Low/High (SL Reference)
  - -27% = Extension Take Profit Target

## Architecture

### Frontend (Expo / React Native)
- **Framework**: Expo Router (file-based routing)
- **State**: React Context (`TradingContext`) for all trading engine state
- **Fonts**: Inter (body/UI) + **Orbitron** (brand name LIBARTIN — futuristic trading font)
- **Theme**: Dark navy trading terminal (#0A0E17 bg, #F0B429 gold accent)
- **Navigation**: 3-tab layout (Dashboard, Signals, Settings)

### Backend (Express + DerivService)
- Port 5000
- Serves landing page + static Expo assets
- **DerivService** (`server/derivService.ts`): persistent Deriv WebSocket connection that runs 24/7
  - Connects to Deriv on server startup, auto-reconnects on disconnect
  - Runs full analysis pipeline: EMA50/200, swing detection, Fibonacci, signal detection
  - API endpoints: `GET /api/market-state`, `GET /api/signals`, `GET /api/health`
  - Runs continuously even when no user has the app open (background server)

### Data Source
- **WebSocket**: `wss://ws.derivws.com/websockets/v3?app_id=114791`
- **Pair**: XAUUSD (frxXAUUSD)
- **M15**: 900 granularity, 300 candles (EMA50/200 + Fibonacci swing detection)
- **M5**: 300 granularity, 100 candles (precision entry confirmation)
- **Auto-reconnect**: 3 second delay; maintenance/weekend handled gracefully

## Key Files

| File | Purpose |
|------|---------|
| `contexts/TradingContext.tsx` | Core trading engine: WebSocket, EMA, ATR, Fibonacci, signals |
| `app/(tabs)/index.tsx` | Dashboard: live price, trend, Fibonacci levels, active signal |
| `app/(tabs)/signals.tsx` | Signal history list with full signal details |
| `app/(tabs)/settings.tsx` | Balance input, risk params, TEST SINYAL VISUAL buttons, strategy reference |
| `app/(tabs)/_layout.tsx` | Tab navigation (NativeTabs for iOS 26 liquid glass, Tabs fallback) |
| `constants/colors.ts` | Design token colors |
| `components/FibChart.tsx` | Interactive chart with M5/M15 timeframe selector |
| `services/NotificationService.ts` | Push notifications: signal, TP, SL alerts |

## Trading Strategy Implementation

### 1. Data: Deriv WebSocket M5+M15 candles, auto-reconnect
### 2. Trend Detection (TREND ALIGNMENT RULE): EMA50 and EMA200 on M15
- Bullish: close > EMA200 AND EMA50 > EMA200
- Bearish: close < EMA200 AND EMA50 < EMA200 → Fibonacci drawn High→Low
- Otherwise: No Trade — Fibonacci NOT generated
### 3. Swing Detection (SWING VALIDATION RULE): Hybrid fractal + local extreme on M15
- **ANCHOR** = latest 5-bar fractal (EMA-aligned, closed candles only, no repaint)
  - Bearish anchor: fractal HIGH (High[i] > 4 neighbors, EMA50 < EMA200 at candle i)
  - Bullish anchor: fractal LOW (Low[i] < 4 neighbors, EMA50 > EMA200 at candle i)
- **PAIR EXTREME** = most recent local trough/peak before the anchor (not fractal-required)
  - Bearish: most recent 3-bar local LOW before anchor = origin of the rally to that high
  - Bullish: most recent 3-bar local HIGH before anchor = origin of the drop to that low
  - Fallback: min/max in 20 candles if no local extreme found
- Fibonacci updates when EITHER anchor changes (new fractal) OR pair extreme moves (market makes new extreme)
- Signal lock resets only on anchor change — NOT on pair extreme changes
### 4. Fibonacci Calculation (FIBONACCI STABILITY RULE):
- Anchor is locked to fractal epoch — stable, no repaint
- Pair extreme updates responsively when market makes new highs/lows
- Bearish: draws from pair low UP to fractal high; zone (61.8%, 78.6%) is near the high
- Bullish: draws from fractal low UP to pair high; zone is near the high
- Levels: 61.8%, 78.6%, -27% extension
- Tracked via `lastSwingRef` (stores anchorEpoch + trend + pairValue)
### 5. Entry (ENTRY VALIDATION RULE on M5) — diperlonggar:
- Zone check DIPERLUAS: 50%–88.6% dari swing range (dari hanya 61.8%–78.6%)
- SELL: closedM5.high >= 50%-level ATAU harga live sudah di dalam zona + bearish close + upper wick >= 0.8x body
- BUY:  closedM5.low <= 50%-level ATAU harga live sudah di dalam zona + bullish close + lower wick >= 0.8x body
- Body center check DIHAPUS (terlalu ketat)
- OR: Partial Engulfing pattern (75% engulf, bukan full)
- ATR filter diturunkan: M5_ATR_MIN = 0.3 (dari 1.0)
### 6. Stop Loss: Swing Low (Buy) atau Swing High (Sell)
### 7. Take Profit: ATR-adaptif untuk scalping realistis
- TP distance = clamp(ATR×1.5, min(extDist, ATR×2.5), ATR×3.5)
- Jika extension terlalu jauh (>3.5 ATR), di-cap
- Jika terlalu dekat (<1.5 ATR), di-floor
- Memberikan RR realistis 1.5–3.5 untuk scalping M5
### 8. Position Sizing: Lot = (1% × Balance) / SL distance
### 9. Filters: Min SL distance (0.1 × ATR14), cooldown 30 menit per fractal anchor (bukan permanent block)

## URL Fix (APK)
- `EXPO_PUBLIC_DOMAIN` dari env var mengandung `:5000` tapi Replit proxy HTTPS bekerja di port 443
- `getBackendUrl()` sekarang strip `:5000` sehingga URL backend correct di APK

### Active Signal Tracking (activeSignal vs currentSignal)
- `currentSignal`: fired when conditions met — becomes null after single-position rule marks anchor
- `activeSignal`: persists the last fired signal until TP or SL is hit
- TP/SL tracking runs against `activeSignal` (not `currentSignal`) — ensures tracking always works
- Dashboard shows `activeSignal` panel (persists until trade is closed by TP/SL)

### Backend Test Signal
- `POST /api/test-signal`: injects test signal with current market data, sends push to all registered devices

## Signal Output Fields
- Pair, Timeframe, Trend, Entry Price, Stop Loss, Take Profit
- Risk:Reward Ratio, Lot Size, Timestamp UTC
- Fibonacci Levels (High, Low, 61.8%, 78.6%, -27%)
- **Outcome**: `"pending"` (default) → `"win"` (TP hit) / `"loss"` (SL hit) — auto-tracked in real-time
- **Status**: `"active"` → `"closed"` after TP/SL hit

## Win Rate Dashboard (Signals Tab)
- Real-time win rate percentage: wins / closed signals × 100%
- Color coded: ≥60% green, ≥45% gold, <45% red
- Stats: Total | Win | Loss | Open (pending) counts
- Visual progress bar: green (wins) vs red (losses)
- Each signal card shows outcome badge: WIN (green) / LOSS (red) / PENDING (blue)

## Fibonacci Chart (FibChart component)

Located at `components/FibChart.tsx`. Uses `react-native-svg` to render:
- Last 50 M5 candlesticks (green/red bodies + wicks)
- EMA50 line (purple) and EMA200 line (orange)
- Dashed horizontal Fibonacci lines: Swing High (green), 61.8% (gold), 78.6% (gold), Swing Low (red), -27% extension (blue)
- Golden zone shading between 61.8% and 78.6%
- Current price label box (live, colored by direction)
- Entry (solid), SL (red dashed), TP (green dashed) lines when signal is active
- Loading overlay while waiting for candles/WebSocket
- Price legend labels on right axis
- Always visible — shows loading state when no data yet

## Auto-Install Script

`scripts/install-deps.sh` — fast dependency installer. Run: `bash scripts/install-deps.sh`

## Market Hours
- `forexMarketOpen()` in TradingContext checks UTC day/time to determine if XAUUSD is trading
- Market open: Mon 00:00 UTC → Fri 22:00 UTC; Sunday open after 22:00 UTC
- When closed: WebSocket disconnects, signal detection paused, candles reset
- When market re-opens (e.g. Sunday 22:00 UTC): auto-reconnects and rebuilds candle history
- 30-second polling interval (`marketCheckTimer`) detects open/close transitions
- Dashboard shows "Pasar Tutup — Weekend" banner with time-until-open countdown
- Connection badge shows "CLOSED" when market is closed

## Signal Candle Marker
- `TradingSignal.signalCandleEpoch` stores the epoch of the candle that triggered the signal
- FibChart draws a colored ▲ BUY or ▼ SELL flag directly on that candle (above for BUY, below for SELL)
- Flag is a filled rectangle with stem line from candle wick tip

## Persistence
- Signal history: AsyncStorage — unlimited (no cap), key: `fibo_signals_v2`
- Account balance: AsyncStorage

## Caching Strategy (Startup Performance)
- M15 candles cached in AsyncStorage (`fibo_m15_candles_v1`) — 200 candles for instant EMA/Fibonacci on boot
- M5 candles cached in AsyncStorage (`fibo_m5_candles_v1`) — for instant chart render
- On startup: cached data loads first, then WebSocket updates in background
- Loading pill badge shows "M15: X/200" when data streaming in
- Market transitions (open/close) keep cached candles visible instead of clearing

## Build APK (Android Production)
- Package name: `com.fibotrader.app`
- EAS config: `eas.json` — all profiles use `buildType: "apk"` (not AAB)
- See BUILD GUIDE section in replit.md for full commands

## Build Guide — Produksi APK

### 1. Install EAS CLI
```
npm install -g eas-cli
```

### 2. Login ke Expo Account
```
eas login
```
Masukkan username/email dan password akun expo.dev kamu.

### 3. Link project ke EAS (pertama kali saja)
```
eas init
```

### 4. Build APK Production (Upload ke cloud EAS)
```
eas build --platform android --profile production
```

### 5. Build APK Lokal (tanpa upload, butuh Android SDK)
```
eas build --platform android --profile production --local
```

### 6. Download APK
Setelah build selesai, EAS akan berikan link download APK-nya.
Atau cek di: https://expo.dev/accounts/[username]/projects/fibotrader/builds

### Notes:
- `production` profile = APK siap install langsung di HP
- Tidak perlu Google Play — APK langsung install (Enable "Install from unknown sources" di Android)
- Build cloud gratis 30 build/bulan di Expo free tier

## AI Integration (LIBARTIN AI)

### File
- `server/aiService.ts` — AI service utama (non-streaming + word-by-word streaming)
- `app/(tabs)/ai.tsx` — Tab baru full-screen AI chat dengan streaming UI
- `server/routes.ts` — Endpoint `/api/ai/*`

### Fitur
- **Tab AI Chat baru** — tab terpisah, full-screen, tidak tertutup keyboard
- **Streaming response** — AI "berpikir" (TypingDots animasi), lalu teks muncul kata per kata
- Otomatis generate rekomendasi saat sinyal BUY/SELL terdeteksi (tanpa request user)
- Otomatis generate komentar saat TP/SL tercapai
- User bisa chat bebas tanya kondisi pasar, analisis teknikal, dll
- Ingatan konteks percakapan (max 3 exchange terakhir)
- Respons bersih tanpa markdown — semua karakter format dihapus oleh stripMarkdown()
- System prompt ketat mencegah halusinasi (hanya bicara berdasarkan data aktual)

### Streaming Architecture
- Server: dapatkan full response dari Pollinations (non-streaming, bersih dari reasoning_content)
- Server: stream kata-per-kata via SSE (`/api/ai/stream`) dengan interval dinamis
- Client: tampilkan TypingDots saat menunggu, lalu teks muncul kata-per-kata (typewriter effect)
- Fix bug: `req.on("close")` diganti `res.on("close")` — body parsing POST request tidak lagi menutup SSE

### API Provider
- Pollinations AI: `https://text.pollinations.ai/v1/chat/completions` (model openai, gratis, tanpa API key)

### Endpoints
- `GET /api/ai/messages` — ambil pesan AI terbaru
- `POST /api/ai/chat` — user kirim pertanyaan ke AI (non-streaming)
- `POST /api/ai/stream` — user kirim pertanyaan ke AI dengan SSE streaming
- `POST /api/ai/outcome` — lapor TP/SL outcome agar AI generate komentar

### Tab Navigation
- 4 tab: Dashboard | Signals | AI Chat | Settings
- AI Chat: full-screen, KeyboardAvoidingView, bubble chat UI

## Workflows
- **Start Backend**: `npm run server:dev` (port 5000)
- **Start Frontend**: `npm run expo:dev` (port 8081)

## Dependencies
- expo, expo-router, expo-blur, expo-haptics, expo-glass-effect
- @tanstack/react-query, @react-native-async-storage/async-storage
- @expo-google-fonts/inter, @expo-google-fonts/orbitron, @expo/vector-icons
- react-native-reanimated, react-native-safe-area-context
- react-native-keyboard-controller, react-native-gesture-handler
- expo-background-fetch, expo-task-manager (background signal monitoring)
- expo-notifications (push + local signal/TP/SL alerts)

## Background & Push Notification Architecture
- **When app is OPEN**: Local WebSocket + local notifications (instant)
- **When app is MINIMIZED**: AppState "active" listener auto-reconnects WebSocket on resume
- **When app is CLOSED**: Backend server (24/7) detects signals → sends Expo Push Notification to device
- **Android permissions**: RECEIVE_BOOT_COMPLETED, FOREGROUND_SERVICE, WAKE_LOCK, POST_NOTIFICATIONS
- **Background fetch**: Registered with `stopOnTerminate: false, startOnBoot: true` for periodic wakeups
- **Sound**: All notifications use sound + max vibration priority on Android channels
