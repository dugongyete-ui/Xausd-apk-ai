import WebSocket from "ws";
import https from "https";
import { aiService } from "./aiService";

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
    ttl: 300,
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
  trend: "Bullish" | "Bearish";
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  riskReward: number;
  timestampUTC: string;
  fibLevels: FibLevels;
  confirmationType: "rejection" | "engulfing";
}

export type TrendState = "Bullish" | "Bearish" | "No Trade" | "Loading";

export interface MarketStateSnapshot {
  currentPrice: number | null;
  trend: TrendState;
  ema50: number | null;
  ema200: number | null;
  fibLevels: FibLevels | null;
  currentSignal: TradingSignal | null;
  inZone: boolean;
  connectionStatus: "connecting" | "connected" | "disconnected";
  marketOpen: boolean;
  lastUpdated: string;
  m15CandleCount: number;
  m5CandleCount: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────
const DERIV_WS_URL = "wss://ws.derivws.com/websockets/v3?app_id=114791";
const SYMBOL = "frxXAUUSD";
const M15_GRAN = 900;
const M15_COUNT = 300;
const M5_GRAN = 300;
const M5_COUNT = 100;
const EMA50_PERIOD = 50;
const EMA200_PERIOD = 200;
const ATR_PERIOD = 14;

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
//  ⑤ EMA alignment: EMA50 > EMA200 untuk bullish, EMA50 < EMA200 untuk bearish
//
// Cara tarik:
//  Uptrend:   SwingLow (start) → SwingHigh (end)  anchorEpoch = SwingHigh.epoch
//  Downtrend: SwingHigh (start) → SwingLow (end)  anchorEpoch = SwingLow.epoch
//
// Fibonacci kemudian dihitung sebagai retracement dari impulse tersebut.
function findSwings(
  candles: Candle[],
  trend: "Bullish" | "Bearish"
): { swingHigh: number; swingLow: number; anchorEpoch: number } | null {
  const LOOKBACK = Math.min(candles.length, 120);
  const slice = candles.slice(-LOOKBACK);
  const n = slice.length;
  if (n < 12) return null;

  const closes = candles.map((c) => c.close);
  const ema50Full = calcEMAFull(closes, EMA50_PERIOD);
  const ema200Full = calcEMAFull(closes, EMA200_PERIOD);
  const offset = candles.length - LOOKBACK;

  // Kumpulkan semua swing high dan low lokal (3-bar fractal)
  // Tidak pakai candle terakhir (live) untuk hindari repaint
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

  // Validasi impulse wave: bersih, satu arah, tidak sideways
  function isCleanImpulse(
    fromIdx: number, toIdx: number,
    fromPrice: number, toPrice: number,
    dir: "up" | "down"
  ): boolean {
    const span = toIdx - fromIdx;
    if (span < 5 || span > 20) return false;
    const range = Math.abs(toPrice - fromPrice);
    if (range < 8) return false;

    // Tidak ada candle yang melampaui 25% range dari ujung start (impulse bersih)
    for (let j = fromIdx; j <= toIdx; j++) {
      if (dir === "up" && slice[j].low < fromPrice - range * 0.25) return false;
      if (dir === "down" && slice[j].high > fromPrice + range * 0.25) return false;
    }

    // Trending: rata-rata close paruh kedua lebih ekstrem dari paruh pertama
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

  if (trend === "Bullish") {
    // Cari impulse naik terbaru: SwingLow → SwingHigh
    for (let hi = swingHighs.length - 1; hi >= 0; hi--) {
      const hIdx = swingHighs[hi];
      const absHi = offset + hIdx;

      // EMA bullish di candle swing high
      const e50 = ema50Full[absHi];
      const e200 = ema200Full[absHi];
      if (isNaN(e50) || isNaN(e200) || e50 <= e200) continue;

      const swingHighPrice = slice[hIdx].high;

      // Cari swing low terdekat sebelum swing high ini
      for (let li = swingLows.length - 1; li >= 0; li--) {
        const lIdx = swingLows[li];
        if (lIdx >= hIdx) continue;

        const swingLowPrice = slice[lIdx].low;
        if (isCleanImpulse(lIdx, hIdx, swingLowPrice, swingHighPrice, "up")) {
          return { swingHigh: swingHighPrice, swingLow: swingLowPrice, anchorEpoch: slice[hIdx].epoch };
        }
      }
    }
  } else {
    // Cari impulse turun terbaru: SwingHigh → SwingLow
    for (let li = swingLows.length - 1; li >= 0; li--) {
      const lIdx = swingLows[li];
      const absLi = offset + lIdx;

      // EMA bearish di candle swing low
      const e50 = ema50Full[absLi];
      const e200 = ema200Full[absLi];
      if (isNaN(e50) || isNaN(e200) || e50 >= e200) continue;

      const swingLowPrice = slice[lIdx].low;

      // Cari swing high terdekat sebelum swing low ini
      for (let hi = swingHighs.length - 1; hi >= 0; hi--) {
        const hIdx = swingHighs[hi];
        if (hIdx >= lIdx) continue;

        const swingHighPrice = slice[hIdx].high;
        if (isCleanImpulse(hIdx, lIdx, swingHighPrice, swingLowPrice, "down")) {
          return { swingHigh: swingHighPrice, swingLow: swingLowPrice, anchorEpoch: slice[lIdx].epoch };
        }
      }
    }
  }
  return null;
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
const M5_ATR_MIN = 0.3; // Turun dari 1.0 → lebih permisif

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
    // Lower wick harus mencapai zona diperluas
    if (candle.low > hi) return false;
    return true;
  }
  if (candle.close >= candle.open) return false;
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  if (upperWick < body * 0.8) return false;
  // Upper wick harus mencapai zona diperluas
  if (candle.high < lo) return false;
  return true;
}

function checkEngulfing(prev: Candle, curr: Candle, trend: "Bullish" | "Bearish"): boolean {
  const prevBody = Math.abs(prev.close - prev.open);
  const currBody = Math.abs(curr.close - curr.open);
  if (prevBody === 0 || currBody === 0) return false;
  // Diperlonggar: cukup curr body >= 75% dari prev body (dari full engulf)
  if (trend === "Bullish") {
    const prevBear = prev.close < prev.open;
    const currBull = curr.close > curr.open;
    if (!prevBear || !currBull) return false;
    // Partial engulfing: curr close melebihi 75% prev body
    const engulfTarget = prev.close + (prev.open - prev.close) * 0.75;
    return curr.close >= engulfTarget && curr.open <= prev.close + prevBody * 0.25;
  }
  const prevBull = prev.close > prev.open;
  const currBear = curr.close < curr.open;
  if (!prevBull || !currBear) return false;
  const engulfTarget = prev.close - (prev.close - prev.open) * 0.75;
  return curr.close <= engulfTarget && curr.open >= prev.close - prevBody * 0.25;
}

function getTrend(m15Candles: Candle[]): TrendState {
  if (m15Candles.length < EMA200_PERIOD) return "Loading";
  const closes = m15Candles.map((c) => c.close);
  const ema50Arr = calcEMA(closes, EMA50_PERIOD);
  const ema200Arr = calcEMA(closes, EMA200_PERIOD);
  if (ema50Arr.length === 0 || ema200Arr.length === 0) return "Loading";
  const ema50 = ema50Arr[ema50Arr.length - 1];
  const ema200 = ema200Arr[ema200Arr.length - 1];
  const last = closes[closes.length - 1];
  if (last > ema200 && ema50 > ema200) return "Bullish";
  if (last < ema200 && ema50 < ema200) return "Bearish";
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

  private m15Candles: Candle[] = [];
  private m5Candles: Candle[] = [];
  private currentPrice: number | null = null;

  private connectionStatus: "connecting" | "connected" | "disconnected" = "disconnected";

  // anchorEpoch = fractal candle epoch. pairValue = swingLow (bearish) or swingHigh (bullish).
  // Fibonacci updates when EITHER anchorEpoch changes (new fractal) OR pairValue changes
  // (market made new extreme with same fractal anchor → zone shifts responsively).
  private lastSwing: { anchorEpoch: number; trend: string; pairValue: number } | null = null;
  private fibLevels: FibLevels | null = null;
  private currentSignal: TradingSignal | null = null;
  // Single position rule: cooldown 30 menit per anchor (bukan permanent block)
  private lastSignaledAnchorEpoch: number | null = null;
  private lastSignaledTimeMs: number = 0;
  private signalHistory: TradingSignal[] = [];
  private savedSignalKeys: Set<string> = new Set();

  private derivMarketClosed = false;

  // ─── Push Token Registry ───────────────────────────────────────────────────
  private pushTokens: Set<string> = new Set();

  registerToken(token: string): void {
    if (!token || !token.startsWith("ExponentPushToken")) {
      console.warn("[PushNotif] Invalid token format:", token?.slice(0, 30));
      return;
    }
    this.pushTokens.add(token);
    console.log(`[PushNotif] Token registered. Total: ${this.pushTokens.size}`);
  }

  unregisterToken(token: string): void {
    this.pushTokens.delete(token);
    console.log(`[PushNotif] Token removed. Remaining: ${this.pushTokens.size}`);
  }

  getTokenCount(): number {
    return this.pushTokens.size;
  }

  start() {
    console.log("[DerivService] Starting background service...");
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
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          this.connect();
        }, 5000);
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

  // ─── FIBONACCI STABILITY RULE ─────────────────────────────────────────────
  // Fibonacci only recalculates when a NEW swing forms.
  // Zones remain static until market structure changes.
  private runAnalysis() {
    if (this.m15Candles.length < EMA200_PERIOD) return;

    const trend = getTrend(this.m15Candles);
    if (trend === "Loading" || trend === "No Trade") {
      this.lastSwing = null;
      this.fibLevels = null;
      this.currentSignal = null;
      return;
    }

    // FIBONACCI STABILITY: only update when fractal ANCHOR CANDLE changes.
    // Compare by anchorEpoch (the timestamp of the fractal candle), NOT by price.
    // Previously: last.swingLow !== swings.swingLow fired every candle because
    // absolute-low shifts whenever price makes a new low — now fixed.
    const swings = findSwings(this.m15Candles, trend);
    if (swings) {
      const last = this.lastSwing;
      const pairValue = trend === "Bearish" ? swings.swingLow : swings.swingHigh;
      const anchorChanged = !last || last.trend !== trend || last.anchorEpoch !== swings.anchorEpoch;
      const pairChanged  = last && last.anchorEpoch === swings.anchorEpoch && last.pairValue !== pairValue;

      if (anchorChanged || pairChanged) {
        this.lastSwing = { anchorEpoch: swings.anchorEpoch, trend, pairValue };
        this.fibLevels = calcFib(swings.swingHigh, swings.swingLow, trend as "Bullish" | "Bearish");
        // Reset signal lock jika anchor baru (bukan sekedar pair update)
        if (anchorChanged) {
          this.lastSignaledAnchorEpoch = null;
        }
        const anchorDate = new Date(swings.anchorEpoch * 1000).toISOString();
        console.log(`[DerivService] Fib updated — Anchor: ${anchorDate}, High: ${swings.swingHigh}, Low: ${swings.swingLow}, Trend: ${trend}${pairChanged ? " [pair moved]" : ""}`);
      }
    } else {
      this.lastSwing = null;
      this.fibLevels = null;
    }

    this.detectSignal(trend as "Bullish" | "Bearish");
  }

  private detectSignal(trend: "Bullish" | "Bearish") {
    const anchorEpoch = this.lastSwing?.anchorEpoch ?? null;

    if (!this.fibLevels || this.m5Candles.length < 3 || this.currentPrice === null || anchorEpoch === null) {
      this.currentSignal = null;
      return;
    }

    // Single position rule: cooldown 30 menit per anchor (bukan permanent block)
    // Jika anchor sama & belum 30 menit, blok. Jika anchor baru, izinkan langsung.
    const SIGNAL_COOLDOWN_MS = 30 * 60 * 1000; // 30 menit
    if (this.lastSignaledAnchorEpoch === anchorEpoch &&
        Date.now() - this.lastSignaledTimeMs < SIGNAL_COOLDOWN_MS) {
      this.currentSignal = null;
      return;
    }

    const atr = calcATR(this.m15Candles, ATR_PERIOD);
    if (atr <= 0) {
      this.currentSignal = null;
      return;
    }

    const fib = this.fibLevels;
    // Zona diperluas untuk zone check: 50%–88.6% dari swing range
    const range = Math.abs(fib.swingHigh - fib.swingLow);
    let lo: number, hi: number;
    if (trend === "Bearish") {
      lo = fib.swingLow + range * 0.50;
      hi = fib.swingLow + range * 0.886;
    } else {
      lo = fib.swingHigh - range * 0.886;
      hi = fib.swingHigh - range * 0.50;
    }

    // ① Gunakan candle CLOSED: n-2 (closed terakhir), n-3 (sebelumnya)
    const closedM5 = this.m5Candles[this.m5Candles.length - 2];
    const prevM5   = this.m5Candles[this.m5Candles.length - 3];

    // ② Zone check: candle CLOSED menyentuh zona diperluas (50%–88.6%)
    // Bearish SELL: high candle harus mencapai atau melewati 50% dari bawah
    // Bullish BUY : low candle harus mencapai atau melewati 50% dari atas
    // Juga izinkan: jika harga live (currentPrice) sudah di dalam zona
    const candleTouchesZone = trend === "Bearish"
      ? closedM5.high >= lo || (this.currentPrice >= lo && this.currentPrice <= hi)
      : closedM5.low <= hi || (this.currentPrice >= lo && this.currentPrice <= hi);
    if (!candleTouchesZone) {
      this.currentSignal = null;
      return;
    }

    // ④ Volatility filter: ATR M5 harus cukup besar (sangat diperlonggar)
    const m5ATR = calcATR(this.m5Candles.slice(0, -1), ATR_PERIOD);
    if (m5ATR < M5_ATR_MIN) {
      this.currentSignal = null;
      return;
    }

    // ③ Rejection pin bar atau Engulfing pattern
    const isRejection = checkRejection(closedM5, trend, fib);
    const isEngulfing = checkEngulfing(prevM5, closedM5, trend);
    if (!isRejection && !isEngulfing) {
      this.currentSignal = null;
      return;
    }

    const confirmationType = isEngulfing ? "engulfing" : "rejection";
    const sl = trend === "Bullish" ? fib.swingLow : fib.swingHigh;
    const slDistance = Math.abs(this.currentPrice - sl);
    if (slDistance < atr * 0.1) {
      this.currentSignal = null;
      return;
    }

    // TP realistis scalping XAUUSD M5:
    // - Floor: max(m5ATR × 2.0, 8 pts) agar tidak terlalu kecil
    // - Cap:   max(m5ATR × 4.0, 20 pts) agar tidak terlalu jauh untuk scalping
    // - Fibonacci extension dipakai jika jatuh dalam range tsb
    const extDist = Math.abs(fib.extensionNeg27 - this.currentPrice);
    const tpFloor = Math.max(m5ATR * 2.0, 8);
    const tpCap   = Math.max(m5ATR * 4.0, 20);
    const atpDist = Math.min(Math.max(extDist, tpFloor), tpCap);
    const tp = trend === "Bearish"
      ? this.currentPrice - atpDist
      : this.currentPrice + atpDist;

    const tpDistance = Math.abs(tp - this.currentPrice);
    const riskReward = Math.round((tpDistance / slDistance) * 100) / 100;

    const nowMs = Date.now();
    const bucket = Math.floor(nowMs / (5 * 60 * 1000));
    const zone = Math.round(this.currentPrice * 2) / 2;
    const sigId = `${zone}_${trend}_${bucket}`;

    const signal: TradingSignal = {
      id: sigId,
      pair: "XAUUSD",
      trend,
      entryPrice: this.currentPrice,
      stopLoss: sl,
      takeProfit: tp,
      riskReward,
      timestampUTC: new Date(nowMs).toUTCString(),
      fibLevels: fib,
      confirmationType,
    };

    this.currentSignal = signal;

    if (!this.savedSignalKeys.has(sigId)) {
      this.savedSignalKeys.add(sigId);
      // Tandai anchor & waktu — cooldown 30 menit untuk anchor yang sama
      this.lastSignaledAnchorEpoch = anchorEpoch;
      this.lastSignaledTimeMs = Date.now();
      this.signalHistory.unshift(signal);
      if (this.signalHistory.length > 100) this.signalHistory.pop();
      console.log(`[DerivService] NEW SIGNAL: ${trend} @ ${this.currentPrice}, RR: ${riskReward}`);

      // ── Kirim Push Notification ke semua device terdaftar ─────────────────
      const isBull = trend === "Bullish";
      const dirEmoji = isBull ? "🟢" : "🔴";
      const dirLabel = isBull ? "BUY ▲" : "SELL ▼";
      const confirmLabel = confirmationType === "engulfing" ? "Engulfing M5" : "Pin Bar M5";

      const pushTitle = `${dirEmoji} LIBARTIN — SINYAL ${dirLabel} XAUUSD`;
      const pushBody =
        `📍 Entry: ${this.currentPrice!.toFixed(2)}\n` +
        `🛑 SL: ${sl.toFixed(2)}  |  🎯 TP: ${tp.toFixed(2)}\n` +
        `📊 R:R 1:${riskReward}  |  ${confirmLabel}`;

      const tokens = Array.from(this.pushTokens);
      if (tokens.length > 0) {
        sendExpoPushNotifications(tokens, pushTitle, pushBody, {
          type: "signal",
          trend,
          signalId: sigId,
          entryPrice: this.currentPrice,
          stopLoss: sl,
          takeProfit: tp,
          riskReward,
        }).catch((e) => console.error("[PushNotif] Error:", e));
      }

      // ── Trigger AI recommendation (non-blocking) ───────────────────────────
      const snapshot = this.getSnapshot();
      aiService.generateSignalRecommendation(signal, snapshot).catch((e) =>
        console.error("[AIService] Signal recommendation error:", e)
      );
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
    let ema200: number | null = null;

    if (closes.length >= EMA50_PERIOD) {
      const arr = calcEMA(closes, EMA50_PERIOD);
      ema50 = arr.length > 0 ? arr[arr.length - 1] : null;
    }
    if (closes.length >= EMA200_PERIOD) {
      const arr = calcEMA(closes, EMA200_PERIOD);
      ema200 = arr.length > 0 ? arr[arr.length - 1] : null;
    }

    const trend = this.m15Candles.length >= EMA200_PERIOD ? getTrend(this.m15Candles) : "Loading";

    let inZone = false;
    if (this.fibLevels && this.currentPrice !== null) {
      const lo = Math.min(this.fibLevels.level618, this.fibLevels.level786);
      const hi = Math.max(this.fibLevels.level618, this.fibLevels.level786);
      inZone = this.currentPrice >= lo && this.currentPrice <= hi;
    }

    return {
      currentPrice: this.currentPrice,
      trend,
      ema50,
      ema200,
      fibLevels: this.fibLevels,
      currentSignal: this.currentSignal,
      inZone,
      connectionStatus: this.connectionStatus,
      marketOpen: forexMarketOpen(),
      lastUpdated: new Date().toUTCString(),
      m15CandleCount: this.m15Candles.length,
      m5CandleCount: this.m5Candles.length,
    };
  }

  getSignalHistory(): TradingSignal[] {
    return this.signalHistory;
  }

  // ─── Test helper: inject signal manually ──────────────────────────────────
  injectTestSignal(params: {
    price: number;
    trend: "Bullish" | "Bearish";
    sl: number;
    tp: number;
    rr: number;
  }): void {
    const nowMs = Date.now();
    const bucket = Math.floor(nowMs / (5 * 60 * 1000));
    const zone = Math.round(params.price * 2) / 2;
    const sigId = `test_${zone}_${params.trend}_${bucket}`;

    const signal: TradingSignal = {
      id: sigId,
      pair: "XAUUSD",
      trend: params.trend,
      entryPrice: params.price,
      stopLoss: params.sl,
      takeProfit: params.tp,
      riskReward: params.rr,
      timestampUTC: new Date(nowMs).toUTCString(),
      fibLevels: this.fibLevels ?? {
        swingHigh: params.price + 30,
        swingLow: params.price - 30,
        level618: params.price + 18,
        level786: params.price + 23,
        extensionNeg27: params.price - 8,
      },
      confirmationType: "rejection",
    };

    this.currentSignal = signal;
    if (!this.savedSignalKeys.has(sigId)) {
      this.savedSignalKeys.add(sigId);
      this.signalHistory.unshift(signal);
      if (this.signalHistory.length > 100) this.signalHistory.pop();
      console.log(`[DerivService] TEST SIGNAL injected: ${params.trend} @ ${params.price}`);
    }

    const isBull = params.trend === "Bullish";
    const dirEmoji = isBull ? "🟢" : "🔴";
    const dirLabel = isBull ? "BUY ▲" : "SELL ▼";
    const pushTitle = `${dirEmoji} [TEST] LIBARTIN — SINYAL ${dirLabel} XAUUSD`;
    const pushBody =
      `📍 Entry: ${params.price.toFixed(2)}\n` +
      `🛑 SL: ${params.sl.toFixed(2)}  |  🎯 TP: ${params.tp.toFixed(2)}\n` +
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
