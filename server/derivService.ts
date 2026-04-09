import WebSocket from "ws";
import https from "https";
import { aiService } from "./aiService";
import { loadSignals, saveSignals, clearAllSignals, loadPushTokens, savePushToken, deletePushToken } from "./signalStore";
import { toWIBString, DERIV_WS_URL as SHARED_WS_URL } from "../shared/utils";
import { detectMarketRegime, MarketRegime } from "../shared/marketRegime";

// ─── Expo Push Notification API ───────────────────────────────────────────────
const EXPO_PUSH_URL = "exp.host";
const EXPO_PUSH_PATH = "/--/api/v2/push/send";

async function sendExpoPushNotifications(
  tokens: string[],
  title: string,
  body: string,
  data: Record<string, unknown> = {}
): Promise<void> {
  if (tokens.length === 0) return;

  const messages = tokens.map((to) => ({
    to,
    title,
    body,
    data,
    sound: "default",
    priority: "high",
    channelId: "trading-signals",
    ttl: 86400,
  }));

  const payload = JSON.stringify(messages);

  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: EXPO_PUSH_URL,
        path: EXPO_PUSH_PATH,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "Accept-Encoding": "gzip, deflate",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => { raw += chunk; });
        res.on("end", () => {
          try {
            const result = JSON.parse(raw);
            if (result.data) {
              result.data.forEach((item: { status: string; id?: string; message?: string }, i: number) => {
                if (item.status === "ok") {
                  console.log(`[PushNotif] Sent to ${tokens[i]?.slice(0, 30)}...`);
                } else {
                  console.warn(`[PushNotif] Failed token ${i}: ${item.message ?? item.status}`);
                }
              });
            }
          } catch {}
          resolve();
        });
      }
    );
    req.on("error", (e) => {
      console.error("[PushNotif] Request error:", e.message);
      resolve();
    });
    req.write(payload);
    req.end();
  });
}

// ─── Types ────────────────────────────────────────────────────────────────────
export interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  epoch: number;
}

export interface FibLevels {
  swingHigh: number;
  swingLow: number;
  level618: number;
  level786: number;
  extensionNeg27: number;
}

export interface TradingSignal {
  id: string;
  pair: string;
  timeframe: string;
  trend: "Bullish" | "Bearish";
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  takeProfit2?: number;
  riskReward: number;
  riskReward2?: number;
  lotSize: number;
  timestampUTC: string;
  fibLevels: FibLevels;
  status: "active" | "closed";
  signalCandleEpoch: number;
  confirmationType: "rejection" | "engulfing";
  outcome?: "win" | "loss" | "pending" | "expired";
  sessionTag?: "active" | "low_confidence";
  effectiveSL?: number;
  confluence?: boolean;
  marketRegime?: MarketRegime;
}

export type TrendState = "Bullish" | "Bearish" | "No Trade" | "Loading";

export interface SignalStats {
  total: number;
  wins: number;
  losses: number;
  pending: number;
  winRate: number;
}

export interface MarketStateSnapshot {
  currentPrice: number | null;
  trend: TrendState;
  fibTrend: "Bullish" | "Bearish" | null;
  ema50: number | null;
  ema20m5: number | null;
  ema50m5: number | null;
  atrM15: number | null;
  fibLevels: FibLevels | null;
  bullFibLevels: FibLevels | null;
  bearFibLevels: FibLevels | null;
  currentSignal: TradingSignal | null;
  recentSignals: TradingSignal[];
  inZone: boolean;
  connectionStatus: "connecting" | "connected" | "disconnected";
  marketOpen: boolean;
  isActiveSession: boolean;
  consecutiveLosses: number;
  cooldownUntil: number | null;
  lastUpdated: string;
  m15CandleCount: number;
  m5CandleCount: number;
  signalStats: SignalStats;
}

// ─── Constants ────────────────────────────────────────────────────────────────
const DERIV_WS_URL = SHARED_WS_URL;
const SYMBOL = "frxXAUUSD";
const M15_GRAN = 900;
const M15_COUNT = 300;
const M5_GRAN = 300;
const M5_COUNT = 200;        // Masalah 1a: naikkan dari 100 → 200 candle (~16 jam)
const EMA20_PERIOD = 20;
const EMA50_PERIOD = 50;
const ATR_PERIOD = 14;
const M5_ATR_MIN_RATIO = 0.5;
const SIGNAL_EXPIRY_MS = 5 * 60 * 60 * 1000;   // Masalah 1d: 5 jam expiry
const MAX_DAILY_LOSS = 3;                         // Masalah 1e: maks 3 consecutive loss
const COOLDOWN_MS    = 4 * 60 * 60 * 1000;       // Masalah 1e: 4 jam cooldown

// ─── Analysis Helpers (mirrors TradingContext logic) ──────────────────────────
function calcEMA(closes: number[], period: number): number[] {
  if (closes.length < period) return [];
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const result: number[] = [ema];
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    result.push(ema);
  }
  return result;
}

function calcEMAFull(closes: number[], period: number): number[] {
  if (closes.length < period) return new Array(closes.length).fill(NaN);
  const k = 2 / (period + 1);
  const result: number[] = new Array(period - 1).fill(NaN);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(ema);
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    result.push(ema);
  }
  return result;
}

function calcATR(candles: Candle[], period: number): number {
  if (candles.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const hl = candles[i].high - candles[i].low;
    const hc = Math.abs(candles[i].high - candles[i - 1].close);
    const lc = Math.abs(candles[i].low - candles[i - 1].close);
    trs.push(Math.max(hl, hc, lc));
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// ─── Impulse Wave Detection ───────────────────────────────────────────────────
// Cari impulse wave M15 terakhir yang jelas berdasarkan STRUKTUR swing, bukan
// hitungan candle tetap.
//
// Kriteria impulse valid:
//  ① Span: 5–20 candle M15 (gerakan satu arah, bukan sideways)
//  ② Range minimal: 8 poin (filter noise)
//  ③ Arah bersih: tidak ada candle yang break > 25% range dari ujung start
//  ④ Trending: rata-rata close paruh kedua > paruh pertama (bullish)
//     atau rata-rata close paruh kedua < paruh pertama (bearish)
//  ⑤ Trend: Harga > EMA50 untuk bullish, Harga < EMA50 untuk bearish
//
// Cara tarik:
//  Uptrend:   SwingLow (start) → SwingHigh (end)  anchorEpoch = SwingHigh.epoch
//  Downtrend: SwingHigh (start) → SwingLow (end)  anchorEpoch = SwingLow.epoch
//
// Fibonacci kemudian dihitung sebagai retracement dari impulse tersebut.
interface SwingResult {
  swingHigh: number;
  swingLow: number;
  anchorEpoch: number;
}

// Mengembalikan KEDUA struktur swing secara independen.
// Bullish: SwingLow → SwingHigh (setup retracement BUY)
// Bearish: SwingHigh → SwingLow (setup retracement SELL)
// Keduanya dievaluasi mandiri — tidak ada yang "mengalahkan" yang lain.
// Masalah 1b: span diperlonggar 3–40 (dari 3–25)
// Masalah 1c: minimum range ATR-relative (0.3 × M15 ATR), bukan hardcoded 5 poin
function findSwings(candles: Candle[], atrM15 = 0): { bullish: SwingResult | null; bearish: SwingResult | null } {
  const LOOKBACK = Math.min(candles.length, 120);
  const slice = candles.slice(-LOOKBACK);
  const n = slice.length;
  if (n < 12) return { bullish: null, bearish: null };

  const swingHighs: number[] = [];
  const swingLows: number[] = [];
  for (let i = 1; i < n - 1; i++) {
    if (slice[i].high > slice[i - 1].high && slice[i].high > slice[i + 1].high) {
      swingHighs.push(i);
    }
    if (slice[i].low < slice[i - 1].low && slice[i].low < slice[i + 1].low) {
      swingLows.push(i);
    }
  }

  function isCleanImpulse(
    fromIdx: number, toIdx: number,
    fromPrice: number, toPrice: number,
    dir: "up" | "down"
  ): boolean {
    const span = toIdx - fromIdx;
    if (span < 3 || span > 40) return false;             // 1b: 25 → 40
    const range = Math.abs(toPrice - fromPrice);
    const minRange = atrM15 > 0 ? atrM15 * 0.3 : 5;    // 1c: ATR-relative
    if (range < minRange) return false;

    for (let j = fromIdx; j <= toIdx; j++) {
      if (dir === "up" && slice[j].low < fromPrice - range * 0.30) return false;
      if (dir === "down" && slice[j].high > fromPrice + range * 0.30) return false;
    }

    const mid = fromIdx + Math.floor(span / 2);
    let sumA = 0, cntA = 0, sumB = 0, cntB = 0;
    for (let j = fromIdx; j <= toIdx; j++) {
      if (j <= mid) { sumA += slice[j].close; cntA++; }
      else { sumB += slice[j].close; cntB++; }
    }
    if (cntA === 0 || cntB === 0) return false;
    const avgA = sumA / cntA;
    const avgB = sumB / cntB;
    if (dir === "up" && avgB <= avgA) return false;
    if (dir === "down" && avgB >= avgA) return false;

    return true;
  }

  // ── Cari impulse NAIK terbaru: SwingLow → SwingHigh (setup BUY) ──────────
  let bullResult: SwingResult | null = null;
  for (let hi = swingHighs.length - 1; hi >= 0; hi--) {
    const hIdx = swingHighs[hi];
    const swingHighPrice = slice[hIdx].high;
    for (let li = swingLows.length - 1; li >= 0; li--) {
      const lIdx = swingLows[li];
      if (lIdx >= hIdx) continue;
      const swingLowPrice = slice[lIdx].low;
      if (isCleanImpulse(lIdx, hIdx, swingLowPrice, swingHighPrice, "up")) {
        bullResult = { swingHigh: swingHighPrice, swingLow: swingLowPrice, anchorEpoch: slice[hIdx].epoch };
        break;
      }
    }
    if (bullResult) break;
  }

  // ── Cari impulse TURUN terbaru: SwingHigh → SwingLow (setup SELL) ────────
  let bearResult: SwingResult | null = null;
  for (let li = swingLows.length - 1; li >= 0; li--) {
    const lIdx = swingLows[li];
    const swingLowPrice = slice[lIdx].low;
    for (let hi = swingHighs.length - 1; hi >= 0; hi--) {
      const hIdx = swingHighs[hi];
      if (hIdx >= lIdx) continue;
      const swingHighPrice = slice[hIdx].high;
      if (isCleanImpulse(hIdx, lIdx, swingHighPrice, swingLowPrice, "down")) {
        bearResult = { swingHigh: swingHighPrice, swingLow: swingLowPrice, anchorEpoch: slice[lIdx].epoch };
        break;
      }
    }
    if (bearResult) break;
  }

  return { bullish: bullResult, bearish: bearResult };
}

function calcFib(swingHigh: number, swingLow: number, trend: "Bullish" | "Bearish"): FibLevels {
  const range = swingHigh - swingLow;
  if (trend === "Bullish") {
    return {
      swingHigh, swingLow,
      level618: swingHigh - range * 0.618,
      level786: swingHigh - range * 0.786,
      extensionNeg27: swingHigh + range * 0.27,
    };
  }
  return {
    swingHigh, swingLow,
    level618: swingLow + range * 0.618,
    level786: swingLow + range * 0.786,
    extensionNeg27: swingLow - range * 0.27,
  };
}

// Rejection Pin Bar — kondisi diperlonggar untuk lebih sering terpenuhi:
// ① Candle arah sesuai trend (close vs open)
// ② Wick dominan ≥ 0.8× body (dari 1.5× — lebih permisif)
// ③ Wick menyentuh/masuk zona DIPERLUAS (50%–88.6%)
// Body center check DIHAPUS — terlalu ketat
// Hanya candle CLOSED yang dievaluasi (dijamin dari caller)

function checkRejection(candle: Candle, trend: "Bullish" | "Bearish", fib: FibLevels): boolean {
  const body = Math.abs(candle.close - candle.open);
  if (body === 0) return false;

  // Zona diperluas: gunakan 50%–88.6% bukan hanya 61.8%–78.6%
  const range = Math.abs(fib.swingHigh - fib.swingLow);
  let lo: number, hi: number;
  if (trend === "Bearish") {
    lo = fib.swingLow + range * 0.50;   // 50%
    hi = fib.swingLow + range * 0.886;  // 88.6%
  } else {
    lo = fib.swingHigh - range * 0.886; // 88.6% retracement
    hi = fib.swingHigh - range * 0.50;  // 50% retracement
  }

  if (trend === "Bullish") {
    if (candle.close <= candle.open) return false;
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;
    if (lowerWick < body * 0.8) return false;
    // Lower wick harus masuk zona (antara lo dan hi), dengan toleransi 15% di bawah lo
    if (candle.low > hi) return false;
    if (candle.low < lo - (hi - lo) * 0.15) return false;
    return true;
  }
  if (candle.close >= candle.open) return false;
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  if (upperWick < body * 0.8) return false;
  // Upper wick harus masuk zona (antara lo dan hi), dengan toleransi 15% di atas hi
  if (candle.high < lo) return false;
  if (candle.high > hi + (hi - lo) * 0.15) return false;
  return true;
}

function checkEngulfing(prev: Candle, curr: Candle, trend: "Bullish" | "Bearish"): boolean {
  const prevBody = Math.abs(prev.close - prev.open);
  const currBody = Math.abs(curr.close - curr.open);
  if (prevBody === 0 || currBody === 0) return false;
  // Candle saat ini harus cukup kuat: body minimal 70% dari prev body
  if (currBody < prevBody * 0.70) return false;
  if (trend === "Bullish") {
    const prevBear = prev.close < prev.open;
    const currBull = curr.close > curr.open;
    if (!prevBear || !currBull) return false;
    // Engulf minimal 65% body prev (dinaikkan dari 55% untuk kualitas lebih tinggi)
    const engulfTarget = prev.close + (prev.open - prev.close) * 0.65;
    return curr.close >= engulfTarget && curr.open <= prev.close + prevBody * 0.25;
  }
  const prevBull = prev.close > prev.open;
  const currBear = curr.close < curr.open;
  if (!prevBull || !currBear) return false;
  // Engulf minimal 65% body prev (dinaikkan dari 55% untuk kualitas lebih tinggi)
  const engulfTarget = prev.close - (prev.close - prev.open) * 0.65;
  return curr.close <= engulfTarget && curr.open >= prev.close - prevBody * 0.25;
}

function getTrend(m15Candles: Candle[]): TrendState {
  if (m15Candles.length < EMA50_PERIOD) return "Loading";
  const closes = m15Candles.map((c) => c.close);
  const ema50Arr = calcEMA(closes, EMA50_PERIOD);
  if (ema50Arr.length === 0) return "Loading";
  const ema50 = ema50Arr[ema50Arr.length - 1];
  const last = closes[closes.length - 1];
  if (last > ema50) return "Bullish";
  if (last < ema50) return "Bearish";
  return "No Trade";
}

function forexMarketOpen(): boolean {
  const now = new Date();
  const day = now.getUTCDay();
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (day === 6) return false;
  if (day === 0) return mins >= 22 * 60;
  if (day === 5) return mins < 22 * 60;
  return true;
}

// ─── Session Filter ────────────────────────────────────────────────────────────
// Masalah 6c: Exclude London open 07:00–07:30 UTC dan NY open 13:00–13:30 UTC
// sebagai "spike zone" (volatilitas tinggi, sering sweep SL).
function isActiveSession(epochMs: number): boolean {
  const d = new Date(epochMs);
  const utcHour = d.getUTCHours();
  const utcMin  = d.getUTCMinutes();
  const minsInDay = utcHour * 60 + utcMin;

  const londonSpike = minsInDay >= 7 * 60 && minsInDay < 7 * 60 + 30;
  const nySpike     = minsInDay >= 13 * 60 && minsInDay < 13 * 60 + 30;
  if (londonSpike || nySpike) return false;

  const london  = utcHour >= 7  && utcHour < 16;
  const newYork = utcHour >= 13 && utcHour < 22;
  return london || newYork;
}

function parseCandle(c: { open: string; high: string; low: string; close: string; epoch: number }): Candle | null {
  const parsed = {
    open: parseFloat(c.open),
    high: parseFloat(c.high),
    low: parseFloat(c.low),
    close: parseFloat(c.close),
    epoch: c.epoch,
  };
  if (isNaN(parsed.open) || isNaN(parsed.high) || isNaN(parsed.low) || isNaN(parsed.close)) return null;
  return parsed;
}

// ─── Deriv Service ────────────────────────────────────────────────────────────
class DerivService {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private marketCheckTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempts = 0;               // Masalah 5d: untuk exponential backoff

  // Masalah 1e: MAX_DAILY_LOSS tracking
  private consecutiveLosses = 0;
  private cooldownUntil: number | null = null;

  // SSE clients untuk real-time push sinyal (Masalah 4b)
  private sseClients: Set<import("express").Response> = new Set();

  private m15Candles: Candle[] = [];
  private m5Candles: Candle[] = [];
  private currentPrice: number | null = null;

  private connectionStatus: "connecting" | "connected" | "disconnected" = "disconnected";

  // ── State Fibonacci TERPISAH per arah ──────────────────────────────────────
  // BUY setup: berdasarkan impulse SwingLow → SwingHigh terbaru
  private lastBullSwing: { anchorEpoch: number; pairValue: number } | null = null;
  private bullFibLevels: FibLevels | null = null;
  private lastBullSignaledEpoch: number | null = null;

  // SELL setup: berdasarkan impulse SwingHigh → SwingLow terbaru
  private lastBearSwing: { anchorEpoch: number; pairValue: number } | null = null;
  private bearFibLevels: FibLevels | null = null;
  private lastBearSignaledEpoch: number | null = null;

  // fibTrend = arah sinyal aktif terakhir (untuk snapshot/display)
  private fibTrend: "Bullish" | "Bearish" | null = null;
  // ID sinyal yang dibatalkan karena trend berbalik — tidak boleh di-resurrect
  private cancelledSignalIds: Set<string> = new Set();

  // ── Zone entry alert tracking ──────────────────────────────────────────────
  // Deteksi transisi harga masuk zona Fibonacci → trigger AI alert otomatis
  // Key = "<swingHigh>_<swingLow>" per arah; reset ketika harga keluar zona
  private inBullZoneState: boolean = false;
  private inBearZoneState: boolean = false;
  private lastBullZoneAlertKey: string | null = null;
  private lastBearZoneAlertKey: string | null = null;
  private signalHistory: TradingSignal[] = (() => {
    const s = loadSignals();
    return s;
  })();
  private savedSignalKeys: Set<string> = new Set(this.signalHistory.map((s) => s.id));
  // Inisialisasi currentSignal dari sinyal pending terbaru di signalHistory saat startup.
  // Menggunakan referensi dari signalHistory (sama objek) agar tidak stale.
  private currentSignal: TradingSignal | null = (() => {
    const pending = this.signalHistory.filter((s) => s.outcome === "pending");
    if (pending.length === 0) return null;
    return pending.sort(
      (a, b) => new Date(b.timestampUTC).getTime() - new Date(a.timestampUTC).getTime()
    )[0];
  })();

  // ── Per-direction active signal tracking (Task 1) ─────────────────────────
  // Max 1 active (unresolved) signal per direction at any time.
  // Hydrated from persisted pending signals on startup so restarts don't bypass cooldown.
  private activeBuySignalId: string | null = (() => {
    const pending = this.signalHistory.filter((s) => s.outcome === "pending" && s.trend === "Bullish");
    if (pending.length === 0) return null;
    return pending.sort((a, b) => new Date(b.timestampUTC).getTime() - new Date(a.timestampUTC).getTime())[0].id;
  })();
  private activeSellSignalId: string | null = (() => {
    const pending = this.signalHistory.filter((s) => s.outcome === "pending" && s.trend === "Bearish");
    if (pending.length === 0) return null;
    return pending.sort((a, b) => new Date(b.timestampUTC).getTime() - new Date(a.timestampUTC).getTime())[0].id;
  })();
  // anchorEpoch is not persisted in signal storage so we cannot hydrate it — set to null and let
  // the first resolved signal clear it, or wait for the Fibonacci anchor to change.
  private bullAnchorSignaled: number | null = null;
  private bearAnchorSignaled: number | null = null;

  private derivMarketClosed = false;

  // ─── Push Token Registry ───────────────────────────────────────────────────
  // Loaded from SQLite on startup so tokens survive server restarts
  private pushTokens: Set<string> = new Set(loadPushTokens());

  registerToken(token: string): void {
    if (!token || !token.startsWith("ExponentPushToken")) {
      console.warn("[PushNotif] Invalid token format:", token?.slice(0, 30));
      return;
    }
    this.pushTokens.add(token);
    savePushToken(token);
    console.log(`[PushNotif] Token registered. Total: ${this.pushTokens.size}`);
  }

  unregisterToken(token: string): void {
    this.pushTokens.delete(token);
    deletePushToken(token);
    console.log(`[PushNotif] Token removed. Remaining: ${this.pushTokens.size}`);
  }

  getTokenCount(): number {
    return this.pushTokens.size;
  }

  start() {
    const mode = process.env.NODE_ENV === "production" ? "production (vm 24/7)" : "development";
    console.log(`[DerivService] Starting background service... mode=${mode}, pushTokens=${this.pushTokens.size}`);
    this.connect();

    this.marketCheckTimer = setInterval(() => {
      const isOpen = forexMarketOpen();
      if (isOpen && !this.derivMarketClosed) {
        const state = this.ws?.readyState;
        if (!this.ws || state === WebSocket.CLOSED || state === WebSocket.CLOSING) {
          if (!this.reconnectTimer) {
            this.derivMarketClosed = false;
            this.connect();
          }
        }
      }
    }, 30_000);
  }

  stop() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.marketCheckTimer) clearInterval(this.marketCheckTimer);
    if (this.ws) { try { this.ws.close(); } catch {} }
  }

  private connect() {
    if (!forexMarketOpen()) {
      console.log("[DerivService] Market closed, skipping connect");
      return;
    }
    if (this.derivMarketClosed) return;
    if (this.ws) { try { this.ws.close(); } catch {} this.ws = null; }

    console.log("[DerivService] Connecting to Deriv WebSocket...");
    this.connectionStatus = "connecting";
    const ws = new WebSocket(DERIV_WS_URL);
    this.ws = ws;

    ws.on("open", () => {
      console.log("[DerivService] Connected to Deriv");
      this.connectionStatus = "connected";
      this.reconnectAttempts = 0;  // reset backoff counter on successful connect

      ws.send(JSON.stringify({
        ticks_history: SYMBOL,
        adjust_start_time: 1,
        count: M15_COUNT,
        end: "latest",
        granularity: M15_GRAN,
        style: "candles",
        subscribe: 1,
      }));

      ws.send(JSON.stringify({
        ticks_history: SYMBOL,
        adjust_start_time: 1,
        count: M5_COUNT,
        end: "latest",
        granularity: M5_GRAN,
        style: "candles",
        subscribe: 1,
      }));
    });

    ws.on("message", (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.error) {
          const errMsg: string = msg.error.message ?? "";
          console.error("[DerivService] WS Error:", errMsg);
          if (
            errMsg.toLowerCase().includes("market is presently closed") ||
            errMsg.toLowerCase().includes("market is closed") ||
            msg.error.code === "MarketIsClosed"
          ) {
            this.derivMarketClosed = true;
          }
          return;
        }

        if (msg.msg_type === "candles" && Array.isArray(msg.candles)) {
          const gran: number = msg.echo_req?.granularity ?? 0;
          const parsed = msg.candles
            .map((c: Parameters<typeof parseCandle>[0]) => parseCandle(c))
            .filter((c: Candle | null): c is Candle => c !== null);
          if (parsed.length === 0) return;

          if (gran === M15_GRAN) {
            this.m15Candles = parsed;
            console.log(`[DerivService] M15 loaded: ${parsed.length} candles`);
          } else if (gran === M5_GRAN) {
            this.m5Candles = parsed;
            this.currentPrice = parsed[parsed.length - 1].close;
            console.log(`[DerivService] M5 loaded: ${parsed.length} candles, price: ${this.currentPrice}`);
          }
          this.runAnalysis();
          return;
        }

        if (msg.msg_type === "ohlc" && msg.ohlc) {
          const o = msg.ohlc;
          const gran: number = o.granularity ?? 0;
          const nc: Candle = {
            open: parseFloat(o.open),
            high: parseFloat(o.high),
            low: parseFloat(o.low),
            close: parseFloat(o.close),
            epoch: o.open_time,
          };
          if (isNaN(nc.open) || isNaN(nc.high) || isNaN(nc.low) || isNaN(nc.close)) return;

          if (gran === M15_GRAN) {
            this.m15Candles = this.updateCandles(this.m15Candles, nc, M15_COUNT);
          } else if (gran === M5_GRAN) {
            this.currentPrice = nc.close;
            this.m5Candles = this.updateCandles(this.m5Candles, nc, M5_COUNT);
          }
          this.runAnalysis();
        }
      } catch (e) {
        console.error("[DerivService] Parse error:", e);
      }
    });

    ws.on("error", (err: Error) => {
      console.error("[DerivService] WS error:", err.message);
      this.connectionStatus = "disconnected";
    });

    ws.on("close", () => {
      console.log("[DerivService] WS closed");
      this.connectionStatus = "disconnected";
      this.ws = null;
      if (forexMarketOpen() && !this.derivMarketClosed) {
        // Masalah 5d: exponential backoff — 1s, 2s, 4s, 8s, 16s, max 30s
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
        this.reconnectAttempts++;
        console.log(`[DerivService] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})...`);
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          this.connect();
        }, delay);
      }
    });
  }

  private updateCandles(prev: Candle[], nc: Candle, maxCount: number): Candle[] {
    if (prev.length === 0) return [nc];
    const last = prev[prev.length - 1];
    if (last.epoch === nc.epoch) {
      const updated = [...prev];
      updated[updated.length - 1] = nc;
      return updated;
    }
    const next = [...prev, nc];
    if (next.length > maxCount) next.shift();
    return next;
  }

  // ─── UPDATE FIBONACCI PER ARAH ────────────────────────────────────────────
  // Fibonacci masing-masing arah diperbarui secara independen ketika:
  // ① anchorEpoch berubah (fractal baru terbentuk), atau
  // ② pairValue berubah (harga membuat ekstrem baru dengan anchor yang sama)
  private updateFibForDirection(
    dir: "Bullish" | "Bearish",
    swing: SwingResult
  ): boolean {
    const pairValue = dir === "Bullish" ? swing.swingHigh : swing.swingLow;
    const last = dir === "Bullish" ? this.lastBullSwing : this.lastBearSwing;

    const anchorChanged = !last || last.anchorEpoch !== swing.anchorEpoch;
    const pairChanged   = last && last.anchorEpoch === swing.anchorEpoch && last.pairValue !== pairValue;

    if (!anchorChanged && !pairChanged) return false;

    const newState = { anchorEpoch: swing.anchorEpoch, pairValue };
    const newFib   = calcFib(swing.swingHigh, swing.swingLow, dir);

    if (dir === "Bullish") {
      this.lastBullSwing    = newState;
      this.bullFibLevels    = newFib;
      if (anchorChanged) {
        this.lastBullSignaledEpoch = null;
        this.bullAnchorSignaled    = null;
        // Reset zone alert state so new anchor can trigger alert when price enters zone
        this.inBullZoneState    = false;
        this.lastBullZoneAlertKey = null;
        aiService.resetZoneKey("Bullish");
      }
    } else {
      this.lastBearSwing    = newState;
      this.bearFibLevels    = newFib;
      if (anchorChanged) {
        this.lastBearSignaledEpoch = null;
        this.bearAnchorSignaled    = null;
        // Reset zone alert state so new anchor can trigger alert when price enters zone
        this.inBearZoneState    = false;
        this.lastBearZoneAlertKey = null;
        aiService.resetZoneKey("Bearish");
      }
    }

    const anchorDate = new Date(swing.anchorEpoch * 1000).toISOString();
    console.log(
      `[DerivService] Fib ${dir} updated — Anchor: ${anchorDate}, ` +
      `High: ${swing.swingHigh}, Low: ${swing.swingLow}` +
      `${pairChanged ? " [pair moved]" : ""}`
    );
    return true;
  }

  // ─── MONITOR TP/SL PENDING SIGNALS ────────────────────────────────────────
  // Jalankan setiap tick untuk update outcome sinyal pending.
  private monitorPendingSignals(): void {
    if (this.currentPrice === null) return;
    const price = this.currentPrice;
    let changed = false;

    // Get latest M5 candle high/low for intra-candle SL/TP detection
    // Using candle.low for BUY SL check and candle.high for SELL SL check
    // prevents missed resolutions when price spikes through SL but closes above it
    const latestM5 = this.m5Candles.length > 0
      ? this.m5Candles[this.m5Candles.length - 1]
      : null;
    const candleLow  = latestM5 ? latestM5.low  : price;
    const candleHigh = latestM5 ? latestM5.high : price;

    // ── Reconcile active-direction state ─────────────────────────────────────
    // On each tick, ensure active*SignalId refers to the most recent unresolved
    // pending signal per direction. This handles legacy data with multiple
    // pending signals per direction or stale IDs after restart.
    const pendingBull = this.signalHistory
      .filter((s) => s.trend === "Bullish" && (!s.outcome || s.outcome === "pending"))
      .sort((a, b) => new Date(b.timestampUTC).getTime() - new Date(a.timestampUTC).getTime());
    const pendingSell = this.signalHistory
      .filter((s) => s.trend === "Bearish" && (!s.outcome || s.outcome === "pending"))
      .sort((a, b) => new Date(b.timestampUTC).getTime() - new Date(a.timestampUTC).getTime());
    if (pendingBull.length > 0 && this.activeBuySignalId !== pendingBull[0].id) {
      this.activeBuySignalId = pendingBull[0].id;
    } else if (pendingBull.length === 0 && this.activeBuySignalId !== null) {
      this.activeBuySignalId = null;
      this.bullAnchorSignaled = null;
    }
    if (pendingSell.length > 0 && this.activeSellSignalId !== pendingSell[0].id) {
      this.activeSellSignalId = pendingSell[0].id;
    } else if (pendingSell.length === 0 && this.activeSellSignalId !== null) {
      this.activeSellSignalId = null;
      this.bearAnchorSignaled = null;
    }

    for (const sig of this.signalHistory) {
      if (sig.outcome && sig.outcome !== "pending") continue;
      const isBull = sig.trend === "Bullish";
      const effectiveSL = sig.effectiveSL !== undefined ? sig.effectiveSL : sig.stopLoss;

      // Masalah 1d: auto-expire sinyal yang sudah > 5 jam tanpa resolve
      const signalAge = Date.now() - new Date(sig.timestampUTC).getTime();
      if (signalAge > SIGNAL_EXPIRY_MS) {
        sig.outcome = "expired";
        changed = true;
        console.log(`[DerivService] Signal ${sig.id} expired after ${Math.round(signalAge / 3600000)}h`);
        this.consecutiveLosses++;
        if (this.consecutiveLosses >= MAX_DAILY_LOSS && !this.cooldownUntil) {
          this.cooldownUntil = Date.now() + COOLDOWN_MS;
          console.log(`[DerivService] MAX_DAILY_LOSS reached (${MAX_DAILY_LOSS}) — 4h cooldown aktif`);
        }
        if (isBull) { this.activeBuySignalId = null; this.bullAnchorSignaled = null; }
        else         { this.activeSellSignalId = null; this.bearAnchorSignaled = null; }
        continue;
      }

      // Use candle high/low for accurate intra-candle SL/TP detection.
      // BUY: SL is hit if candle LOW touches or breaks below SL level.
      //      TP is hit if candle HIGH touches or exceeds TP level.
      // SELL: SL is hit if candle HIGH touches or breaks above SL level.
      //       TP is hit if candle LOW touches or drops below TP level.
      const slHit  = isBull ? candleLow  <= effectiveSL    : candleHigh >= effectiveSL;
      const tp1Hit = isBull ? candleHigh >= sig.takeProfit  : candleLow  <= sig.takeProfit;
      const tp2Hit = sig.takeProfit2 !== undefined
        ? (isBull ? candleHigh >= sig.takeProfit2 : candleLow <= sig.takeProfit2)
        : false;

      // SL has priority: if SL and TP hit on the same candle (spike/gap),
      // treat as LOSS (conservative, realistic assumption).
      if (slHit) {
        const isBreakevenStop = sig.effectiveSL !== undefined;
        sig.outcome = isBreakevenStop ? "win" : "loss";
        changed = true;
        const hitPrice = isBull ? candleLow : candleHigh;
        if (isBreakevenStop) {
          this.consecutiveLosses = 0;
          this.cooldownUntil = null;
          console.log(`[DerivService] Signal ${sig.id} hit breakeven SL → WIN (TP1 locked) @ low/high ${hitPrice}`);
          this.triggerOutcomeCommentary(sig.id, "win");
        } else {
          // Masalah 1e: hitung consecutive loss
          this.consecutiveLosses++;
          if (this.consecutiveLosses >= MAX_DAILY_LOSS && !this.cooldownUntil) {
            this.cooldownUntil = Date.now() + COOLDOWN_MS;
            console.log(`[DerivService] MAX_DAILY_LOSS reached (${MAX_DAILY_LOSS}) — 4h cooldown aktif`);
          }
          console.log(`[DerivService] Signal ${sig.id} hit SL → LOSS @ low/high ${hitPrice} (consecutive: ${this.consecutiveLosses})`);
          this.triggerOutcomeCommentary(sig.id, "loss");
        }
        if (isBull) { this.activeBuySignalId = null; this.bullAnchorSignaled = null; }
        else         { this.activeSellSignalId = null; this.bearAnchorSignaled = null; }
      } else if (tp2Hit) {
        sig.outcome = "win";
        changed = true;
        this.consecutiveLosses = 0;
        this.cooldownUntil = null;
        const hitPrice = isBull ? candleHigh : candleLow;
        console.log(`[DerivService] Signal ${sig.id} hit TP2 → WIN @ high/low ${hitPrice}`);
        this.triggerOutcomeCommentary(sig.id, "win");
        if (isBull) { this.activeBuySignalId = null; this.bullAnchorSignaled = null; }
        else         { this.activeSellSignalId = null; this.bearAnchorSignaled = null; }
      } else if (tp1Hit && sig.effectiveSL === undefined) {
        sig.effectiveSL = sig.entryPrice;
        changed = true;
        const hitPrice = isBull ? candleHigh : candleLow;
        console.log(`[DerivService] Signal ${sig.id} hit TP1 @ high/low ${hitPrice} → SL trailed to breakeven @ ${sig.entryPrice}`);
        // Push zero-floating update ke semua SSE clients secara real-time
        this.emitSSE("signal_update", { ...sig });
      }
    }
    if (changed) saveSignals(this.signalHistory);
  }

  // ─── MAIN ANALYSIS LOOP ───────────────────────────────────────────────────
  // Jalankan analisis KEDUA arah setiap tick/candle baru.
  // BUY dan SELL dievaluasi mandiri — keduanya bisa valid sekaligus.
  private runAnalysis() {
    if (this.m15Candles.length < EMA50_PERIOD) return;

    this.monitorPendingSignals();

    // Hitung ATR M15 terlebih dahulu untuk dipakai di findSwings (Masalah 1c)
    const atrM15 = calcATR(this.m15Candles, ATR_PERIOD);
    const swings = findSwings(this.m15Candles, atrM15);

    // ── Update Fibonacci BUY ──────────────────────────────────────────────
    if (swings.bullish) {
      this.updateFibForDirection("Bullish", swings.bullish);
    } else {
      this.lastBullSwing  = null;
      this.bullFibLevels  = null;
    }

    // ── Update Fibonacci SELL ─────────────────────────────────────────────
    if (swings.bearish) {
      this.updateFibForDirection("Bearish", swings.bearish);
    } else {
      this.lastBearSwing  = null;
      this.bearFibLevels  = null;
    }

    // ── Invalidasi currentSignal jika trend M15 berbalik arah ─────────────
    // Jika sinyal aktif berlawanan dengan trend EMA50 M15 saat ini, batalkan.
    // Tambahkan ke cancelledSignalIds agar tidak bisa di-resurrect oleh fallback.
    const liveTrend = getTrend(this.m15Candles);
    if (this.currentSignal && (liveTrend === "Bullish" || liveTrend === "Bearish")) {
      const signalDir = this.currentSignal.trend;
      if (
        (signalDir === "Bullish" && liveTrend === "Bearish") ||
        (signalDir === "Bearish" && liveTrend === "Bullish")
      ) {
        console.log(
          `[DerivService] Sinyal aktif ${signalDir} (${this.currentSignal.id}) dibatalkan — trend M15 berbalik ke ${liveTrend}`
        );
        this.cancelledSignalIds.add(this.currentSignal.id);
        this.currentSignal = null;
        this.fibTrend = liveTrend;
      }
    }

    // ── Deteksi Zone Entry → trigger AI alert otomatis ───────────────────
    // Hanya alert ketika harga baru MASUK zona (transisi false→true).
    // Tidak alert jika sinyal sudah aktif untuk arah itu (sudah confirmed).
    if (this.currentPrice !== null) {
      const checkZoneEntry = (fib: FibLevels | null, dir: "Bullish" | "Bearish"): boolean => {
        if (!fib) return false;
        const range = Math.abs(fib.swingHigh - fib.swingLow);
        let lo: number, hi: number;
        if (dir === "Bearish") {
          lo = fib.swingLow + range * 0.50;
          hi = fib.swingLow + range * 0.886;
        } else {
          lo = fib.swingHigh - range * 0.886;
          hi = fib.swingHigh - range * 0.50;
        }
        return this.currentPrice! >= lo && this.currentPrice! <= hi;
      };

      const nowInBull = checkZoneEntry(this.bullFibLevels, "Bullish");
      const nowInBear = checkZoneEntry(this.bearFibLevels, "Bearish");
      const hasBullSignal = this.activeBuySignalId !== null;
      const hasBearSignal = this.activeSellSignalId !== null;

      // BUY zone entry
      if (nowInBull && !this.inBullZoneState && !hasBullSignal && this.bullFibLevels) {
        this.inBullZoneState = true;
        const key = `bull_${this.bullFibLevels.swingHigh.toFixed(1)}_${this.bullFibLevels.swingLow.toFixed(1)}`;
        if (key !== this.lastBullZoneAlertKey) {
          this.lastBullZoneAlertKey = key;
          const snap = this.getSnapshot();
          aiService.generateZoneAlert(snap, "Bullish", key).catch((e) =>
            console.error("[AIService] Zone alert BUY error:", e)
          );
        }
      } else if (!nowInBull) {
        if (this.inBullZoneState) {
          this.inBullZoneState = false;
          this.lastBullZoneAlertKey = null;
          aiService.resetZoneKey("Bullish");
        }
      }

      // SELL zone entry
      if (nowInBear && !this.inBearZoneState && !hasBearSignal && this.bearFibLevels) {
        this.inBearZoneState = true;
        const key = `bear_${this.bearFibLevels.swingHigh.toFixed(1)}_${this.bearFibLevels.swingLow.toFixed(1)}`;
        if (key !== this.lastBearZoneAlertKey) {
          this.lastBearZoneAlertKey = key;
          const snap = this.getSnapshot();
          aiService.generateZoneAlert(snap, "Bearish", key).catch((e) =>
            console.error("[AIService] Zone alert SELL error:", e)
          );
        }
      } else if (!nowInBear) {
        if (this.inBearZoneState) {
          this.inBearZoneState = false;
          this.lastBearZoneAlertKey = null;
          aiService.resetZoneKey("Bearish");
        }
      }
    }

    // ── Evaluasi sinyal kedua arah ────────────────────────────────────────
    const bullSignal = this.detectSignalForDirection("Bullish");
    const bearSignal = this.detectSignalForDirection("Bearish");

    // Pilih sinyal yang valid.
    // Jika keduanya valid, pilih berdasarkan trend M15 aktif (EMA50 gate),
    // bukan epoch terbaru — konsistensi arah lebih penting dari recency.
    if (bullSignal && bearSignal) {
      if (liveTrend === "Bullish") {
        this.currentSignal = bullSignal;
      } else if (liveTrend === "Bearish") {
        this.currentSignal = bearSignal;
      } else {
        // No Trade / Loading — ambil yang anchorEpoch-nya lebih baru
        const bullAnchor = this.lastBullSwing?.anchorEpoch ?? 0;
        const bearAnchor = this.lastBearSwing?.anchorEpoch ?? 0;
        this.currentSignal = bearAnchor >= bullAnchor ? bearSignal : bullSignal;
      }
    } else {
      this.currentSignal = bullSignal ?? bearSignal ?? null;
    }
  }

  // ─── DETEKSI SINYAL PER ARAH ──────────────────────────────────────────────
  // Memeriksa satu arah (Bullish/Bearish) secara mandiri.
  // Return TradingSignal jika valid, null jika tidak.
  //
  // TAHAP 1 — Guard M15: Konfirmasi trend M15 wajib terpenuhi terlebih dahulu.
  //   BUY  hanya valid jika harga M15 > EMA50 M15 (trend Bullish).
  //   SELL hanya valid jika harga M15 < EMA50 M15 (trend Bearish).
  // TAHAP 2 — Konfirmasi M5: Zone check + candlestick pattern pada candle CLOSED.
  //   Tidak ada live price yang digunakan sebagai pemicu sinyal (anti-repaint).
  private detectSignalForDirection(trend: "Bullish" | "Bearish"): TradingSignal | null {
    const fib           = trend === "Bullish" ? this.bullFibLevels : this.bearFibLevels;
    const anchorEpoch   = trend === "Bullish" ? this.lastBullSwing?.anchorEpoch : this.lastBearSwing?.anchorEpoch;
    const lastSigEpoch  = trend === "Bullish" ? this.lastBullSignaledEpoch : this.lastBearSignaledEpoch;

    if (!fib || !anchorEpoch || this.m5Candles.length < 3) {
      return null;
    }

    // Masalah 1e: cooldown setelah MAX_DAILY_LOSS consecutive losses
    if (this.cooldownUntil && Date.now() < this.cooldownUntil) {
      const minsLeft = Math.round((this.cooldownUntil - Date.now()) / 60000);
      if (minsLeft % 60 === 0) {
        console.log(`[DerivService] In cooldown — ${minsLeft} menit tersisa`);
      }
      return null;
    } else if (this.cooldownUntil && Date.now() >= this.cooldownUntil) {
      this.cooldownUntil = null;
      this.consecutiveLosses = 0;
      console.log("[DerivService] Cooldown selesai — sinyal kembali aktif");
    }

    // ── Task 1: Cooldown — max 1 active signal per direction ──────────────────
    // Block new signal if same anchorEpoch already produced an unresolved signal
    // or if a signal for this direction is still pending (active).
    const anchorSignaled = trend === "Bullish" ? this.bullAnchorSignaled : this.bearAnchorSignaled;
    const activeId       = trend === "Bullish" ? this.activeBuySignalId  : this.activeSellSignalId;

    if (anchorSignaled === anchorEpoch) {
      // AnchorEpoch already produced an unresolved signal in this direction
      const existing = activeId ? this.signalHistory.find((s) => s.id === activeId) ?? null : null;
      return existing;
    }
    if (activeId !== null) {
      // Another signal in this direction is still unresolved
      const existing = this.signalHistory.find((s) => s.id === activeId) ?? null;
      return existing;
    }

    // ── TAHAP 1: Guard M15 — EMA50 structure confirmation ─────────────────
    // BUY wajib: harga M15 > EMA50. SELL wajib: harga M15 < EMA50.
    // Jika M15 tidak mendukung arah, sinyal TIDAK diproses sama sekali.
    if (this.m15Candles.length >= EMA50_PERIOD) {
      const m15Closes = this.m15Candles.map((c) => c.close);
      const ema50Arr = calcEMA(m15Closes, EMA50_PERIOD);
      if (ema50Arr.length > 0) {
        const ema50 = ema50Arr[ema50Arr.length - 1];
        const lastM15Close = m15Closes[m15Closes.length - 1];
        if (trend === "Bullish" && lastM15Close <= ema50) {
          return null;
        }
        if (trend === "Bearish" && lastM15Close >= ema50) {
          return null;
        }
      }
    }

    // ── Task 4: EMA20 M5 micro-trend confirmation ──────────────────────────
    // BUY requires EMA20 M5 > EMA50 M5; SELL requires the inverse.
    if (this.m5Candles.length >= EMA50_PERIOD) {
      const m5Closes = this.m5Candles.map((c) => c.close);
      const ema20Arr = calcEMA(m5Closes, EMA20_PERIOD);
      const ema50Arr = calcEMA(m5Closes, EMA50_PERIOD);
      if (ema20Arr.length > 0 && ema50Arr.length > 0) {
        const ema20m5 = ema20Arr[ema20Arr.length - 1];
        const ema50m5 = ema50Arr[ema50Arr.length - 1];
        if (trend === "Bullish" && ema20m5 <= ema50m5) return null;
        if (trend === "Bearish" && ema20m5 >= ema50m5) return null;
      }
    }

    const atrM15 = calcATR(this.m15Candles, ATR_PERIOD);
    if (atrM15 <= 0) return null;

    // Minimum Fibonacci range: swing harus setidaknya 1× ATR M15
    // agar entry zone dan TP memiliki ruang yang cukup
    const range = Math.abs(fib.swingHigh - fib.swingLow);
    if (range < atrM15 * 1.0) return null;

    let lo: number, hi: number;
    if (trend === "Bearish") {
      lo = fib.swingLow + range * 0.50;
      hi = fib.swingLow + range * 0.886;
    } else {
      lo = fib.swingHigh - range * 0.886;
      hi = fib.swingHigh - range * 0.50;
    }

    // ── TAHAP 2: Konfirmasi M5 — gunakan HANYA candle CLOSED (anti-repaint) ──
    // Candle closed: n-2 (paling baru yang sudah tutup), n-3 (sebelumnya)
    const closedM5 = this.m5Candles[this.m5Candles.length - 2];
    const prevM5   = this.m5Candles[this.m5Candles.length - 3];

    // Zone check: wick candle harus masuk DALAM zona fib (50%–88.6%), bukan cuma sentuh satu sisi.
    // Bearish: high harus di antara lo dan hi (+ toleransi 15%). Bullish: low harus di antara lo dan hi (- toleransi 15%).
    const zoneTol = (hi - lo) * 0.15;
    const candleTouchesZone = trend === "Bearish"
      ? closedM5.high >= lo && closedM5.high <= hi + zoneTol
      : closedM5.low  <= hi && closedM5.low  >= lo - zoneTol;
    if (!candleTouchesZone) return null;

    // Volatility filter M5 — dinamis: M5 ATR harus ≥ M5_ATR_MIN_RATIO × M15 ATR
    const m5ATR = calcATR(this.m5Candles.slice(0, -1), ATR_PERIOD);
    if (m5ATR < atrM15 * M5_ATR_MIN_RATIO) return null;

    // M5 body filter: reject doji/indecision candles where body < 30% of full range
    const m5FullRange = closedM5.high - closedM5.low;
    const m5Body = Math.abs(closedM5.close - closedM5.open);
    if (m5FullRange > 0 && m5Body < m5FullRange * 0.3) return null;

    // Konfirmasi candlestick: Pin Bar Rejection atau Engulfing
    const isRejection = checkRejection(closedM5, trend, fib);
    const isEngulfing  = checkEngulfing(prevM5, closedM5, trend);
    if (!isRejection && !isEngulfing) return null;

    const sl = trend === "Bullish" ? fib.swingLow : fib.swingHigh;

    // Engulfing WAJIB ada confluence: near round number (.25/.50) ATAU near swing point M5
    // Cek menggunakan harga entry (close candle M5) sebagai referensi, bukan midpoint entry/SL
    if (isEngulfing && !isRejection) {
      const entryRef = closedM5.close;
      const nearRoundForEngulf = [25, 50].some((step) => {
        const nearest = Math.round(entryRef / step) * step;
        return Math.abs(entryRef - nearest) <= 2;
      });
      // Juga cek swing point M5 terdekat dalam 10 candle terakhir
      const recentM5 = this.m5Candles.slice(-12, -2);
      const recentHighs = recentM5.map((c) => c.high);
      const recentLows  = recentM5.map((c) => c.low);
      const nearSwingM5 = [...recentHighs, ...recentLows].some(
        (p) => Math.abs(p - entryRef) <= 3
      );
      if (!nearRoundForEngulf && !nearSwingM5) return null;
    }

    const confirmationType = isEngulfing ? "engulfing" : "rejection";

    // Dedup: satu sinyal per candle M5 closed per arah
    if (lastSigEpoch === closedM5.epoch) {
      const sigId = `${closedM5.epoch}_${trend}`;
      const existing = this.signalHistory.find((s) => s.id === sigId);
      return existing ?? null;
    }

    // Gunakan harga penutupan candle M5 (bukan harga live) sebagai entry
    const entryPrice = closedM5.close;
    const slDistance = Math.abs(entryPrice - sl);

    // ── Task 2: Minimum SL distance filter ────────────────────────────────────
    // Reject if SL distance < 0.3× ATR M15 or < 2.0 points (noise floor for XAUUSD)
    if (slDistance < atrM15 * 0.3) return null;
    if (slDistance < 2.0) return null;

    // ── Task 3: TP2 = Fib 127.2% + 0.5× ATR M15, dengan cap 3× ATR M15 (6e) ──
    const tp2Raw = trend === "Bearish"
      ? fib.swingLow - range * 0.272 - atrM15 * 0.5
      : fib.swingHigh + range * 0.272 + atrM15 * 0.5;
    const maxTp2Dist = atrM15 * 3;
    const tp2RawDist = Math.abs(tp2Raw - entryPrice);
    const tp2Dist_capped = atrM15 > 0 ? Math.min(tp2RawDist, maxTp2Dist) : tp2RawDist;
    const tp2 = trend === "Bearish"
      ? entryPrice - tp2Dist_capped
      : entryPrice + tp2Dist_capped;

    // ── TP1: minimum 1:1 RR from entry (SL distance), clamped to not exceed TP2 ──
    const tp1Raw = trend === "Bearish" ? entryPrice - slDistance : entryPrice + slDistance;
    const tp1 = trend === "Bearish"
      ? Math.max(tp1Raw, tp2)  // for SELL: tp1 must not go below tp2 (tp2 is lower)
      : Math.min(tp1Raw, tp2); // for BUY:  tp1 must not exceed tp2 (tp2 is higher)

    const tp1Dist = Math.abs(tp1 - entryPrice);
    const tp2Dist = Math.abs(tp2 - entryPrice);

    const rr1 = Math.round((tp1Dist / slDistance) * 100) / 100;
    const rr2 = Math.round((tp2Dist / slDistance) * 100) / 100;

    // Filter sinyal dengan RR2 terlalu kecil (minimum 1.5 untuk kualitas sinyal)
    const MIN_RR2 = 1.5;
    if (rr2 < MIN_RR2) return null;

    // ── Confluence detection: check if any part of the 61.8%–78.6% entry zone
    // overlaps within ±2 pts of a round number or ±3 pts of a recent swing high/low ──
    const zoneL = trend === "Bearish" ? fib.swingLow + range * 0.618 : fib.swingHigh - range * 0.786;
    const zoneH = trend === "Bearish" ? fib.swingLow + range * 0.786 : fib.swingHigh - range * 0.618;
    const nearRound = [25, 50].some((step) => {
      const nearestL = Math.round(zoneL / step) * step;
      const nearestH = Math.round(zoneH / step) * step;
      return Math.abs(zoneL - nearestL) <= 2 || Math.abs(zoneH - nearestH) <= 2;
    });
    const swingsForConf = findSwings(this.m15Candles);
    const swingPoints: number[] = [];
    if (swingsForConf.bullish) { swingPoints.push(swingsForConf.bullish.swingHigh, swingsForConf.bullish.swingLow); }
    if (swingsForConf.bearish) { swingPoints.push(swingsForConf.bearish.swingHigh, swingsForConf.bearish.swingLow); }
    const nearSwing = swingPoints.some((p) => p >= zoneL - 3 && p <= zoneH + 3);
    const confluence = nearRound || nearSwing;

    const nowMs = Date.now();
    const sigId = `${closedM5.epoch}_${trend}`;

    // ── Task 5: Session filter — tag signal as low_confidence if outside active sessions ──
    const sessionTag: "active" | "low_confidence" = isActiveSession(nowMs) ? "active" : "low_confidence";
    if (!isActiveSession(nowMs)) {
      console.log(`[DerivService] ${trend} signal outside active session — tagged low_confidence`);
    }

    // lotSize: kalkulasi berdasarkan default balance $10.000, risk 1% per trade
    const defaultBalance = 10000;
    const riskAmount = defaultBalance * 0.01;
    const lotSize = Math.round((riskAmount / slDistance) * 100) / 100;

    const marketRegime = detectMarketRegime(this.m15Candles);

    const signal: TradingSignal = {
      id: sigId,
      pair: "XAUUSD",
      timeframe: "M15/M5",
      trend,
      entryPrice,
      stopLoss: sl,
      takeProfit: tp1,
      takeProfit2: tp2,
      riskReward: rr1,
      riskReward2: rr2,
      lotSize,
      timestampUTC: toWIBString(new Date(nowMs)),
      fibLevels: fib,
      status: "active",
      signalCandleEpoch: closedM5.epoch,
      confirmationType,
      outcome: "pending",
      sessionTag,
      confluence,
      marketRegime,
    };

    // Simpan sinyal baru ke history (hanya sekali per sigId)
    if (!this.savedSignalKeys.has(sigId)) {
      this.savedSignalKeys.add(sigId);

      // Update epoch dedup per arah
      if (trend === "Bullish") this.lastBullSignaledEpoch = closedM5.epoch;
      else                      this.lastBearSignaledEpoch = closedM5.epoch;

      // Task 1: register this signal as the active one for this direction & anchor
      if (trend === "Bullish") {
        this.activeBuySignalId = sigId;
        this.bullAnchorSignaled = anchorEpoch;
      } else {
        this.activeSellSignalId = sigId;
        this.bearAnchorSignaled = anchorEpoch;
      }

      this.fibTrend = trend;
      this.signalHistory.unshift(signal);
      if (this.signalHistory.length > 500) this.signalHistory.pop();
      saveSignals(this.signalHistory);
      console.log(
        `[DerivService] NEW ${trend.toUpperCase()} SIGNAL @ ${this.currentPrice}, ` +
        `TP1: ${tp1.toFixed(2)}, TP2: ${tp2.toFixed(2)}, RR: ${rr1}/${rr2}, ` +
        `Konfirmasi: ${confirmationType}`
      );

      // Masalah 4b: Push sinyal ke semua SSE clients secara real-time
      this.emitSSE("signal", signal);

      // ── Kirim Push Notification ke semua device terdaftar ─────────────────
      const isBull = trend === "Bullish";
      const dirEmoji = isBull ? "🟢" : "🔴";
      const dirLabel = isBull ? "BUY ▲" : "SELL ▼";
      const confirmLabel = confirmationType === "engulfing" ? "Engulfing M5" : "Pin Bar M5";

      // Extract HH:MM WIB dari timestampUTC (format: "Sen, 09 Apr 2026 14:35:00 WIB")
      const timeMatch = signal.timestampUTC.match(/(\d{2}:\d{2}):\d{2} WIB/);
      const timeLabel = timeMatch ? `${timeMatch[1]} WIB` : "";

      const pushTitle = `${dirEmoji} LIBARTIN — SINYAL ${dirLabel} XAUUSD`;
      const pushBody =
        `⏰ ${timeLabel}\n` +
        `📍 Entry: ${entryPrice.toFixed(2)}\n` +
        `🛑 SL: ${sl.toFixed(2)}\n` +
        `🎯 TP1: ${tp1.toFixed(2)}  |  TP2: ${tp2.toFixed(2)}\n` +
        `📊 R:R 1:${rr1} / 1:${rr2}  |  ${confirmLabel}`;

      const tokens = Array.from(this.pushTokens);
      if (tokens.length > 0) {
        sendExpoPushNotifications(tokens, pushTitle, pushBody, {
          type: "signal",
          trend,
          signalId: sigId,
          entryPrice,
          stopLoss: sl,
          takeProfit: tp1,
          takeProfit2: tp2,
          riskReward: rr1,
          riskReward2: rr2,
          marketRegime,
        }).catch((e) => console.error("[PushNotif] Error:", e));
      }

      // ── Trigger AI recommendation (non-blocking) ───────────────────────────
      const snapshot = this.getSnapshot();
      aiService.generateSignalRecommendation(signal, snapshot).catch((e) =>
        console.error("[AIService] Signal recommendation error:", e)
      );
    }

    return signal;
  }

  // ─── SSE Client Management (Masalah 4b) ─────────────────────────────────────
  addSSEClient(res: import("express").Response): void {
    this.sseClients.add(res);
    console.log(`[SSE] Client connected. Total: ${this.sseClients.size}`);
  }

  removeSSEClient(res: import("express").Response): void {
    this.sseClients.delete(res);
    console.log(`[SSE] Client disconnected. Total: ${this.sseClients.size}`);
  }

  private emitSSE(event: string, data: unknown): void {
    if (this.sseClients.size === 0) return;
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.write(msg);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  // ─── AI Outcome Commentary ─────────────────────────────────────────────────
  triggerOutcomeCommentary(signalId: string, outcome: "win" | "loss"): void {
    const signal = this.signalHistory.find((s) => s.id === signalId);
    if (!signal) return;
    const snapshot = this.getSnapshot();
    aiService.generateOutcomeCommentary(signal, outcome, snapshot).catch((e) =>
      console.error("[AIService] Outcome commentary error:", e)
    );
  }

  // ─── Public state accessors ───────────────────────────────────────────────
  getSnapshot(): MarketStateSnapshot {
    const closes = this.m15Candles.map((c) => c.close);
    let ema50: number | null = null;

    if (closes.length >= EMA50_PERIOD) {
      const arr = calcEMA(closes, EMA50_PERIOD);
      ema50 = arr.length > 0 ? arr[arr.length - 1] : null;
    }

    const m5Closes = this.m5Candles.map((c) => c.close);
    let ema20m5: number | null = null;
    let ema50m5: number | null = null;

    if (m5Closes.length >= EMA20_PERIOD) {
      const arr = calcEMA(m5Closes, EMA20_PERIOD);
      ema20m5 = arr.length > 0 ? arr[arr.length - 1] : null;
    }
    if (m5Closes.length >= EMA50_PERIOD) {
      const arr = calcEMA(m5Closes, EMA50_PERIOD);
      ema50m5 = arr.length > 0 ? arr[arr.length - 1] : null;
    }

    const trend = getTrend(this.m15Candles);

    // Tentukan fib aktif untuk display: pakai fib arah sinyal aktif,
    // atau fib yang paling baru dari kedua arah jika tidak ada sinyal.
    const activeFib: FibLevels | null = this.currentSignal
      ? (this.currentSignal.trend === "Bullish" ? this.bullFibLevels : this.bearFibLevels)
      : (this.bullFibLevels ?? this.bearFibLevels);

    let inZone = false;
    if (this.currentPrice !== null) {
      const checkZone = (fib: FibLevels | null, dir: "Bullish" | "Bearish") => {
        if (!fib) return false;
        const range = Math.abs(fib.swingHigh - fib.swingLow);
        let lo: number, hi: number;
        if (dir === "Bearish") {
          lo = fib.swingLow + range * 0.50;
          hi = fib.swingLow + range * 0.886;
        } else {
          lo = fib.swingHigh - range * 0.886;
          hi = fib.swingHigh - range * 0.50;
        }
        return this.currentPrice! >= lo && this.currentPrice! <= hi;
      };
      inZone = checkZone(this.bullFibLevels, "Bullish") || checkZone(this.bearFibLevels, "Bearish");
    }

    const wins = this.signalHistory.filter((s) => s.outcome === "win").length;
    const losses = this.signalHistory.filter((s) => s.outcome === "loss").length;
    const pending = this.signalHistory.filter((s) => !s.outcome || s.outcome === "pending").length;
    const resolved = wins + losses;
    const signalStats: SignalStats = {
      total: this.signalHistory.length,
      wins,
      losses,
      pending,
      winRate: resolved > 0 ? Math.round((wins / resolved) * 100) : 0,
    };

    // fibTrend: reflect live M15 trend so UI & AI always see current market direction.
    // Falls back to last known signal direction if trend is No Trade / Loading.
    const liveFibTrend: "Bullish" | "Bearish" | null =
      trend === "Bullish" ? "Bullish"
      : trend === "Bearish" ? "Bearish"
      : this.fibTrend;

    const atrM15Val = this.m15Candles.length >= ATR_PERIOD
      ? calcATR(this.m15Candles, ATR_PERIOD)
      : null;

    return {
      currentPrice: this.currentPrice,
      trend,
      fibTrend: liveFibTrend,
      ema50,
      ema20m5,
      ema50m5,
      atrM15: atrM15Val && atrM15Val > 0 ? atrM15Val : null,
      fibLevels: activeFib,
      bullFibLevels: this.bullFibLevels,
      bearFibLevels: this.bearFibLevels,
      currentSignal: this.currentSignal,
      recentSignals: this.signalHistory.slice(0, 10),
      inZone,
      connectionStatus: this.connectionStatus,
      marketOpen: forexMarketOpen(),
      isActiveSession: isActiveSession(Date.now()),
      consecutiveLosses: this.consecutiveLosses,
      cooldownUntil: this.cooldownUntil,
      lastUpdated: new Date().toUTCString(),
      m15CandleCount: this.m15Candles.length,
      m5CandleCount: this.m5Candles.length,
      signalStats,
    };
  }

  getSignalHistory(): TradingSignal[] {
    return this.signalHistory;
  }

  // Kembalikan sinyal pending terbaru dari history (untuk fallback restart).
  // Filter: tidak termasuk sinyal yang sudah dibatalkan karena trend berbalik,
  // dan hanya sinyal yang arahnya sesuai dengan trend M15 aktif saat ini.
  getLatestPendingSignal(): TradingSignal | null {
    const liveTrend = getTrend(this.m15Candles);
    const pending = this.signalHistory.filter((s) => {
      if (s.outcome !== "pending") return false;
      if (this.cancelledSignalIds.has(s.id)) return false;
      // Hanya izinkan sinyal yang searah dengan trend M15 aktif
      if (liveTrend === "Bullish" && s.trend !== "Bullish") return false;
      if (liveTrend === "Bearish" && s.trend !== "Bearish") return false;
      return true;
    });
    if (pending.length === 0) return null;
    return pending.sort(
      (a, b) => new Date(b.timestampUTC).getTime() - new Date(a.timestampUTC).getTime()
    )[0];
  }

  clearSignalHistory(): void {
    this.signalHistory = [];
    this.savedSignalKeys.clear();
    this.currentSignal = null;
    // Reset per-direction cooldown state so signal generation is not blocked after clear
    this.activeBuySignalId  = null;
    this.activeSellSignalId = null;
    this.bullAnchorSignaled = null;
    this.bearAnchorSignaled = null;
    clearAllSignals();
    console.log("[DerivService] Signal history cleared by client request");
  }

  // ─── Test helper: inject signal manually ──────────────────────────────────
  injectTestSignal(params: {
    price: number;
    trend: "Bullish" | "Bearish";
    sl: number;
    tp: number;
    tp2?: number;
    rr: number;
    rr2?: number;
  }): void {
    const nowMs = Date.now();
    const bucket = Math.floor(nowMs / (5 * 60 * 1000));
    const zone = Math.round(params.price * 2) / 2;
    const sigId = `test_${zone}_${params.trend}_${bucket}`;

    const slDist = Math.abs(params.price - params.sl);
    const testLotSize = slDist > 0 ? Math.round((100 / slDist) * 100) / 100 : 0.01;

    const signal: TradingSignal = {
      id: sigId,
      pair: "XAUUSD",
      timeframe: "M15/M5",
      trend: params.trend,
      entryPrice: params.price,
      stopLoss: params.sl,
      takeProfit: params.tp,
      takeProfit2: params.tp2,
      riskReward: params.rr,
      riskReward2: params.rr2,
      lotSize: testLotSize,
      timestampUTC: toWIBString(new Date(nowMs)),
      fibLevels: (() => {
        const base = (params.trend === "Bullish" ? this.bullFibLevels : this.bearFibLevels);
        if (!base) {
          return {
            swingHigh: params.trend === "Bearish" ? params.sl : params.price + 30,
            swingLow:  params.trend === "Bullish" ? params.sl : params.price - 30,
            level618: params.price + (params.trend === "Bullish" ? 18 : -18),
            level786: params.price + (params.trend === "Bullish" ? 23 : -23),
            extensionNeg27: params.price + (params.trend === "Bullish" ? -8 : 8),
          };
        }
        // Pastikan swingHigh/Low konsisten dengan params.sl
        return {
          ...base,
          swingHigh: params.trend === "Bearish" ? params.sl : base.swingHigh,
          swingLow:  params.trend === "Bullish" ? params.sl : base.swingLow,
        };
      })(),
      status: "active",
      signalCandleEpoch: Math.floor(nowMs / 1000),
      confirmationType: "rejection",
      outcome: "pending",
    };

    this.currentSignal = signal;
    if (!this.savedSignalKeys.has(sigId)) {
      this.savedSignalKeys.add(sigId);
      this.signalHistory.unshift(signal);
      if (this.signalHistory.length > 100) this.signalHistory.pop();
      console.log(`[DerivService] TEST SIGNAL injected: ${params.trend} @ ${params.price} TP1:${params.tp} TP2:${params.tp2}`);
    }

    const isBull = params.trend === "Bullish";
    const dirEmoji = isBull ? "🟢" : "🔴";
    const dirLabel = isBull ? "BUY ▲" : "SELL ▼";
    const pushTitle = `${dirEmoji} [TEST] LIBARTIN — SINYAL ${dirLabel} XAUUSD`;
    const tp2Line = params.tp2 ? `  |  TP2: ${params.tp2.toFixed(2)}` : "";
    const pushBody =
      `📍 Entry: ${params.price.toFixed(2)}\n` +
      `🛑 SL: ${params.sl.toFixed(2)}\n` +
      `🎯 TP1: ${params.tp.toFixed(2)}${tp2Line}\n` +
      `📊 R:R 1:${params.rr}  |  TEST Signal`;

    const tokens = Array.from(this.pushTokens);
    console.log(`[DerivService] Sending test push to ${tokens.length} device(s)...`);
    if (tokens.length > 0) {
      sendExpoPushNotifications(tokens, pushTitle, pushBody, {
        type: "test-signal",
        trend: params.trend,
        signalId: sigId,
      }).catch((e) => console.error("[PushNotif] Test error:", e));
    } else {
      console.warn("[DerivService] No push tokens registered — open app first to register");
    }
  }
}

export const derivService = new DerivService();
