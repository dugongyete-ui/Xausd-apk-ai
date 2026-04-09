/**
 * LIBARTIN Backtest Script
 * Mengambil data historis 24 jam XAUUSD dari Deriv API,
 * lalu memutar ulang bar-by-bar menggunakan logika strategi yang sama.
 */

import WebSocket from "ws";
import * as fs from "fs";
import * as path from "path";
import { detectMarketRegime, MarketRegime } from "../shared/marketRegime";

// ─── Types ────────────────────────────────────────────────────────────────────
interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  epoch: number;
}

interface FibLevels {
  swingHigh: number;
  swingLow: number;
  level618: number;
  level786: number;
  extensionNeg27: number;
}

interface BacktestSignal {
  id: string;
  trend: "Bullish" | "Bearish";
  entryPrice: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  rr1: number;
  rr2: number;
  signalEpoch: number;
  confirmationType: "rejection" | "engulfing";
  outcome: "win_tp2" | "win_breakeven" | "loss" | "expired";
  resolvedEpoch?: number;
  resolutionNote: string;
  sessionTag: "active" | "low_confidence";
  anchorEpoch: number;
  confluence: boolean;
  mae: number;
  regime: MarketRegime;
}

// ─── Constants ─────────────────────────────────────────────────────────────────
const DERIV_WS_URL = "wss://ws.binaryws.com/websockets/v3?app_id=1089";
const SYMBOL = "frxXAUUSD";
const M15_GRAN = 900;
const M5_GRAN = 300;
const EMA20_PERIOD = 20;
const EMA50_PERIOD = 50;
const ATR_PERIOD = 14;
const M5_ATR_MIN_RATIO = 0.5;
const MAX_SIGNAL_LOOKAHEAD_BARS = 60; // Max 60 M5 bars (~5 jam) untuk resolve outcome
const MIN_RR2 = 1.0;                  // Minimum RR di TP2 agar sinyal layak diambil

// ─── CLI Args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DAYS_WINDOW = (() => { const d = args.find((a) => a.startsWith("--days=")); if (!d) return 7; const n = parseInt(d.split("=")[1]); return Math.min(30, Math.max(1, isNaN(n) ? 7 : n)); })();
const FILTER_SESSION = args.includes("--active-only"); // hanya hitung active session di winrate utama
const SAVE_RESULTS = args.includes("--save"); // export results to JSON file

// ─── Helpers ──────────────────────────────────────────────────────────────────
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

function getTrend(m15Candles: Candle[]): "Bullish" | "Bearish" | "No Trade" | "Loading" {
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

interface SwingResult {
  swingHigh: number;
  swingLow: number;
  anchorEpoch: number;
}

function findSwings(candles: Candle[]): { bullish: SwingResult | null; bearish: SwingResult | null } {
  const LOOKBACK = Math.min(candles.length, 120);
  const slice = candles.slice(-LOOKBACK);
  const n = slice.length;
  if (n < 12) return { bullish: null, bearish: null };

  const swingHighs: number[] = [];
  const swingLows: number[] = [];
  for (let i = 1; i < n - 1; i++) {
    if (slice[i].high > slice[i - 1].high && slice[i].high > slice[i + 1].high) swingHighs.push(i);
    if (slice[i].low < slice[i - 1].low && slice[i].low < slice[i + 1].low) swingLows.push(i);
  }

  function isCleanImpulse(fromIdx: number, toIdx: number, fromPrice: number, toPrice: number, dir: "up" | "down"): boolean {
    const span = toIdx - fromIdx;
    if (span < 3 || span > 25) return false;
    const range = Math.abs(toPrice - fromPrice);
    if (range < 5) return false;
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
    return { swingHigh, swingLow, level618: swingHigh - range * 0.618, level786: swingHigh - range * 0.786, extensionNeg27: swingHigh + range * 0.27 };
  }
  return { swingHigh, swingLow, level618: swingLow + range * 0.618, level786: swingLow + range * 0.786, extensionNeg27: swingLow - range * 0.27 };
}

function checkRejection(candle: Candle, trend: "Bullish" | "Bearish", fib: FibLevels): boolean {
  const body = Math.abs(candle.close - candle.open);
  if (body === 0) return false;
  const range = Math.abs(fib.swingHigh - fib.swingLow);
  let lo: number, hi: number;
  if (trend === "Bearish") {
    lo = fib.swingLow + range * 0.50;
    hi = fib.swingLow + range * 0.886;
  } else {
    lo = fib.swingHigh - range * 0.886;
    hi = fib.swingHigh - range * 0.50;
  }
  if (trend === "Bullish") {
    if (candle.close <= candle.open) return false;
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;
    if (lowerWick < body * 0.8) return false;
    if (candle.low > hi) return false;
    return true;
  }
  if (candle.close >= candle.open) return false;
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  if (upperWick < body * 0.8) return false;
  if (candle.high < lo) return false;
  return true;
}

function checkEngulfing(prev: Candle, curr: Candle, trend: "Bullish" | "Bearish"): boolean {
  const prevBody = Math.abs(prev.close - prev.open);
  const currBody = Math.abs(curr.close - curr.open);
  if (prevBody === 0 || currBody === 0) return false;
  if (trend === "Bullish") {
    if (!(prev.close < prev.open) || !(curr.close > curr.open)) return false;
    const engulfTarget = prev.close + (prev.open - prev.close) * 0.55;
    return curr.close >= engulfTarget && curr.open <= prev.close + prevBody * 0.35;
  }
  if (!(prev.close > prev.open) || !(curr.close < curr.open)) return false;
  const engulfTarget = prev.close - (prev.close - prev.open) * 0.55;
  return curr.close <= engulfTarget && curr.open >= prev.close - prevBody * 0.35;
}

// ─── Session Filter ────────────────────────────────────────────────────────────
function isActiveSession(epochMs: number): boolean {
  const utcHour = new Date(epochMs).getUTCHours();
  const london  = utcHour >= 7  && utcHour < 16;
  const newYork = utcHour >= 13 && utcHour < 22;
  return london || newYork;
}

// ─── Fetch historical candles from Deriv via WS ────────────────────────────────
function fetchCandles(granularity: number, startEpoch: number, endEpoch: number): Promise<Candle[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(DERIV_WS_URL);
    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error(`Timeout fetching granularity ${granularity}`));
    }, 30000);

    ws.on("open", () => {
      ws.send(JSON.stringify({
        ticks_history: SYMBOL,
        start: startEpoch,
        end: endEpoch,
        granularity,
        style: "candles",
        adjust_start_time: 1,
      }));
    });

    ws.on("message", (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.error) {
          clearTimeout(timeout);
          ws.terminate();
          reject(new Error(msg.error.message));
          return;
        }
        if (msg.msg_type === "candles" && Array.isArray(msg.candles)) {
          clearTimeout(timeout);
          ws.terminate();
          const candles: Candle[] = msg.candles
            .map((c: { open: string; high: string; low: string; close: string; epoch: number }) => ({
              open: parseFloat(c.open),
              high: parseFloat(c.high),
              low: parseFloat(c.low),
              close: parseFloat(c.close),
              epoch: c.epoch,
            }))
            .filter((c: Candle) => !isNaN(c.open));
          resolve(candles);
        }
      } catch (e) {
        clearTimeout(timeout);
        ws.terminate();
        reject(e);
      }
    });

    ws.on("error", (err: Error) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

// ─── Chunked fetch: transparently splits requests that exceed 5000 candles ─────
const MAX_CANDLES_PER_REQUEST = 4999; // hard cap leaving 1 candle headroom for inclusive boundaries

async function fetchCandlesChunked(granularity: number, startEpoch: number, endEpoch: number): Promise<Candle[]> {
  // Inclusive estimate: number of candle slots from startEpoch to endEpoch
  const estimatedCandles = Math.floor((endEpoch - startEpoch) / granularity) + 1;
  if (estimatedCandles <= MAX_CANDLES_PER_REQUEST) {
    return fetchCandles(granularity, startEpoch, endEpoch);
  }

  // Each chunk covers at most MAX_CANDLES_PER_REQUEST candles
  // Span of one chunk (inclusive): MAX_CANDLES_PER_REQUEST candles → (MAX_CANDLES_PER_REQUEST - 1) * granularity seconds wide
  const chunkSpan = (MAX_CANDLES_PER_REQUEST - 1) * granularity;
  const chunks: Array<[number, number]> = [];
  let chunkStart = startEpoch;
  while (chunkStart <= endEpoch) {
    const chunkEnd = Math.min(chunkStart + chunkSpan, endEpoch);
    chunks.push([chunkStart, chunkEnd]);
    chunkStart = chunkEnd + granularity; // next chunk starts on next candle boundary
  }

  console.log(`        (splitting into ${chunks.length} chunks to stay within API limits)`);

  const allCandles: Candle[] = [];
  for (let idx = 0; idx < chunks.length; idx++) {
    const [cs, ce] = chunks[idx];
    const part = await fetchCandles(granularity, cs, ce);
    allCandles.push(...part);
  }

  // Deduplicate by epoch and sort
  const seen = new Set<number>();
  const deduped: Candle[] = [];
  for (const c of allCandles) {
    if (!seen.has(c.epoch)) {
      seen.add(c.epoch);
      deduped.push(c);
    }
  }
  deduped.sort((a, b) => a.epoch - b.epoch);
  return deduped;
}

// ─── Wilson score confidence interval for a proportion ────────────────────────
function wilsonCI(wins: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 0];
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, centre - margin), Math.min(1, centre + margin)];
}

// ─── Evaluate outcome of a signal given subsequent candles ─────────────────────
// Implements breakeven trailing: after TP1 is hit, SL moves to entry price,
// trade continues monitoring for TP2. If breakeven SL is hit → win_breakeven.
function evaluateOutcome(
  signal: { trend: "Bullish" | "Bearish"; entryPrice: number; stopLoss: number; takeProfit1: number; takeProfit2: number; signalEpoch: number },
  allM5Candles: Candle[]
): { outcome: "win_tp2" | "win_breakeven" | "loss" | "expired"; resolvedEpoch?: number; resolutionNote: string; mae: number } {
  const signalIdx = allM5Candles.findIndex((c) => c.epoch >= signal.signalEpoch);
  if (signalIdx < 0) return { outcome: "expired", resolutionNote: "candle not found", mae: 0 };

  const startIdx = signalIdx + 1;
  const endIdx = Math.min(startIdx + MAX_SIGNAL_LOOKAHEAD_BARS, allM5Candles.length);
  const isBull = signal.trend === "Bullish";

  let effectiveSL = signal.stopLoss;
  let tp1Locked = false;
  let mae = 0;

  for (let i = startIdx; i < endIdx; i++) {
    const c = allM5Candles[i];
    const tp2Hit = isBull ? c.high >= signal.takeProfit2 : c.low <= signal.takeProfit2;
    const tp1Hit = isBull ? c.high >= signal.takeProfit1 : c.low <= signal.takeProfit1;
    const slHit  = isBull ? c.low  <= effectiveSL        : c.high >= effectiveSL;

    // Track MAE: adverse movement against position
    const adverseMove = isBull
      ? Math.max(0, signal.entryPrice - c.low)
      : Math.max(0, c.high - signal.entryPrice);
    if (adverseMove > mae) mae = adverseMove;

    // FIX: handle TP2 + SL same bar with candle body heuristic (previously TP2 was ignored)
    if (tp2Hit) {
      if (!slHit) return { outcome: "win_tp2", resolvedEpoch: c.epoch, resolutionNote: `TP2 hit @ bar ${i - signalIdx}`, mae };
      // TP2 and SL hit same bar — use candle body direction to determine winner
      const candleDir2 = c.close > c.open ? "bull" : "bear";
      if ((isBull && candleDir2 === "bull") || (!isBull && candleDir2 === "bear")) {
        return { outcome: "win_tp2", resolvedEpoch: c.epoch, resolutionNote: `TP2+SL same bar, body favors entry @ bar ${i - signalIdx}`, mae };
      }
      return { outcome: "loss", resolvedEpoch: c.epoch, resolutionNote: `TP2+SL same bar, body against entry @ bar ${i - signalIdx}`, mae };
    }

    if (!tp1Locked) {
      // TP1 not yet reached
      if (tp1Hit && !slHit) {
        // Trail SL to breakeven and continue
        tp1Locked = true;
        effectiveSL = signal.entryPrice;
        continue;
      }
      if (slHit && !tp1Hit) return { outcome: "loss", resolvedEpoch: c.epoch, resolutionNote: `SL hit @ bar ${i - signalIdx}`, mae };
      // Both triggered same bar before TP1 locked — use candle body heuristic
      if (tp1Hit && slHit) {
        const candleDir = c.close > c.open ? "bull" : "bear";
        if ((isBull && candleDir === "bull") || (!isBull && candleDir === "bear")) {
          tp1Locked = true;
          effectiveSL = signal.entryPrice;
          continue;
        } else {
          return { outcome: "loss", resolvedEpoch: c.epoch, resolutionNote: `TP1+SL same bar, body against entry @ bar ${i - signalIdx}`, mae };
        }
      }
    } else {
      // TP1 already hit — monitoring breakeven stop vs TP2
      if (slHit) return { outcome: "win_breakeven", resolvedEpoch: c.epoch, resolutionNote: `Breakeven SL hit after TP1 @ bar ${i - signalIdx}`, mae };
    }
  }
  // With breakeven trailing, TP1 alone is not terminal — trade stays open until TP2 or trailing SL.
  // If neither resolved within lookahead, classify as expired regardless of TP1 state.
  return { outcome: "expired", resolutionNote: `Belum resolve dalam ${MAX_SIGNAL_LOOKAHEAD_BARS} bar M5${tp1Locked ? " (TP1 hit, awaiting TP2/BE)" : ""}`, mae };
}

// ─── Main Backtest ─────────────────────────────────────────────────────────────
async function runBacktest() {
  const nowEpoch = Math.floor(Date.now() / 1000);
  const startEpoch = nowEpoch - DAYS_WINDOW * 24 * 3600;

  // Butuh konteks M15 lebih panjang untuk swing detection (300 candle M15 = ~75 jam)
  const m15ContextStart = Math.min(startEpoch - 300 * M15_GRAN, nowEpoch - 300 * M15_GRAN);

  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  LIBARTIN BACKTEST — XAUUSD — ${DAYS_WINDOW} HARI TERAKHIR`);
  console.log(`  Filter session aktif: ${FILTER_SESSION ? "YA (--active-only)" : "TIDAK (semua sinyal)"}`);
  console.log(`  Min RR2 filter      : ${MIN_RR2}`);
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Periode  : ${new Date(startEpoch * 1000).toISOString()} → ${new Date(nowEpoch * 1000).toISOString()}`);
  console.log(`  Lookback M15 context: ${new Date(m15ContextStart * 1000).toISOString()}`);
  console.log("  Mengambil data dari Deriv API...\n");
  console.log("  Penggunaan: npx tsx scripts/backtest.ts [--days=N] [--active-only]");
  console.log("  Contoh   : npx tsx scripts/backtest.ts --days=7 --active-only\n");

  let m15All: Candle[];
  let m5All: Candle[];

  try {
    console.log("  [1/2] Mengambil candle M15 (konteks + window)...");
    m15All = await fetchCandlesChunked(M15_GRAN, m15ContextStart, nowEpoch);
    console.log(`        ✓ ${m15All.length} candle M15 diterima`);

    console.log("  [2/2] Mengambil candle M5 (window + 200 konteks)...");
    const m5Start = startEpoch - (200 * M5_GRAN);
    m5All = await fetchCandlesChunked(M5_GRAN, m5Start, nowEpoch);
    console.log(`        ✓ ${m5All.length} candle M5 diterima\n`);
  } catch (err) {
    console.error("  ✗ Gagal mengambil data:", (err as Error).message);
    process.exit(1);
  }

  // ─── Replay bar-by-bar ────────────────────────────────────────────────────
  // Hanya evaluasi bar M5 yang berada dalam window 24 jam terakhir
  const m5BacktestStart = startEpoch;
  const m5BacktestBars = m5All.filter((c) => c.epoch >= m5BacktestStart);

  console.log("─── Memulai Simulasi Bar-by-Bar ───────────────────────────────");
  console.log(`  Total bar M5 dalam 24 jam: ${m5BacktestBars.length}`);
  console.log("─────────────────────────────────────────────────────────────\n");

  const signals: BacktestSignal[] = [];
  const seenSignalIds = new Set<string>();

  // Shadow stats for ADX filter comparison: track non-trending signals separately
  // These are NOT pushed to `signals` — they exist only for the regime comparison summary.
  interface ShadowStat { regime: MarketRegime; outcome: "win_tp2" | "win_breakeven" | "loss" | "expired" }
  const shadowStats: ShadowStat[] = [];
  const seenShadowIds = new Set<string>();

  // Task 1: per-direction cooldown tracking
  const activeBuyId:  { id: string | null; anchor: number | null } = { id: null, anchor: null };
  const activeSellId: { id: string | null; anchor: number | null } = { id: null, anchor: null };

  // Helper: check if a signal has fully resolved given subsequent candles up to a given index.
  // Mirrors live breakeven-trailing model: trade resolves only at TP2 or effective SL.
  // After TP1 is hit, effectiveSL trails to entry — resolves at TP2 or trailing SL breach.
  function isResolved(sig: BacktestSignal, m5All: Candle[], upToIdx: number): boolean {
    const start = m5All.findIndex((c) => c.epoch >= sig.signalEpoch);
    if (start < 0) return false;
    const isBull = sig.trend === "Bullish";
    let effectiveSL = sig.stopLoss;
    let tp1Locked = false;
    for (let j = start + 1; j <= upToIdx; j++) {
      const c = m5All[j];
      const tp2Hit = isBull ? c.high >= sig.takeProfit2 : c.low <= sig.takeProfit2;
      const tp1Hit = isBull ? c.high >= sig.takeProfit1 : c.low <= sig.takeProfit1;
      const slHit  = isBull ? c.low  <= effectiveSL     : c.high >= effectiveSL;
      if (tp2Hit) return true;           // TP2 full win — resolved
      if (!tp1Locked) {
        if (tp1Hit && !slHit) { tp1Locked = true; effectiveSL = sig.entryPrice; continue; }
        if (slHit) return true;          // original SL hit — resolved as loss
        if (tp1Hit && slHit) {
          const candleDir = c.close > c.open ? "bull" : "bear";
          if ((isBull && candleDir === "bull") || (!isBull && candleDir === "bear")) {
            tp1Locked = true; effectiveSL = sig.entryPrice; continue;
          }
          return true;                   // SL wins same-bar heuristic — resolved as loss
        }
      } else {
        if (slHit) return true;          // breakeven SL hit — resolved as win_breakeven
      }
    }
    return false;  // still open (TP1 hit but TP2/breakeven not yet resolved)
  }

  // Untuk setiap bar M5 yang kita "tutup" (bar ke-i menjadi closedM5 = [-2])
  // kita butuh: m5Candles[0..i+1] (i+1 adalah bar live/current)
  for (let i = 0; i < m5All.length - 1; i++) {
    const m5Slice = m5All.slice(0, i + 2); // index 0 hingga i+1 (i+1 = live bar)
    if (m5Slice.length < 3) continue;

    const closedM5 = m5Slice[m5Slice.length - 2];
    const prevM5 = m5Slice[m5Slice.length - 3];

    // Hanya proses bar dalam window 24 jam
    if (closedM5.epoch < m5BacktestStart) continue;

    // M15 candles up to closedM5 time
    const m15Slice = m15All.filter((c) => c.epoch <= closedM5.epoch);
    if (m15Slice.length < EMA50_PERIOD) continue;

    // Compute ADX regime for this bar (used for stats and filter)
    const regime = detectMarketRegime(m15Slice);

    const swings = findSwings(m15Slice);

    // Task 1: clear active signal state if it has been resolved by this point
    if (activeBuyId.id !== null) {
      const existing = signals.find((s) => s.id === activeBuyId.id);
      if (existing && isResolved(existing, m5All, i)) {
        activeBuyId.id = null; activeBuyId.anchor = null;
      }
    }
    if (activeSellId.id !== null) {
      const existing = signals.find((s) => s.id === activeSellId.id);
      if (existing && isResolved(existing, m5All, i)) {
        activeSellId.id = null; activeSellId.anchor = null;
      }
    }

    // Evaluate both directions
    for (const dir of ["Bullish", "Bearish"] as const) {
      const swing = dir === "Bullish" ? swings.bullish : swings.bearish;
      if (!swing) continue;

      const activeTracker = dir === "Bullish" ? activeBuyId : activeSellId;

      // Task 1: cooldown — skip if same anchorEpoch already produced an active signal
      // or if any signal in this direction is still unresolved
      if (activeTracker.anchor === swing.anchorEpoch || activeTracker.id !== null) continue;

      const fib = calcFib(swing.swingHigh, swing.swingLow, dir);
      const sigId = `${closedM5.epoch}_${dir}`;
      if (seenSignalIds.has(sigId)) continue;

      // TAHAP 1: EMA50 M15 guard
      const m15Closes = m15Slice.map((c) => c.close);
      const ema50Arr = calcEMA(m15Closes, EMA50_PERIOD);
      if (ema50Arr.length === 0) continue;
      const ema50 = ema50Arr[ema50Arr.length - 1];
      const lastM15Close = m15Closes[m15Closes.length - 1];
      if (dir === "Bullish" && lastM15Close <= ema50) continue;
      if (dir === "Bearish" && lastM15Close >= ema50) continue;

      // Task 4: EMA20 M5 micro-trend guard
      const m5Closes = m5Slice.map((c) => c.close);
      if (m5Closes.length >= EMA50_PERIOD) {
        const ema20m5Arr = calcEMA(m5Closes, EMA20_PERIOD);
        const ema50m5Arr = calcEMA(m5Closes, EMA50_PERIOD);
        if (ema20m5Arr.length > 0 && ema50m5Arr.length > 0) {
          const ema20m5 = ema20m5Arr[ema20m5Arr.length - 1];
          const ema50m5 = ema50m5Arr[ema50m5Arr.length - 1];
          if (dir === "Bullish" && ema20m5 <= ema50m5) continue;
          if (dir === "Bearish" && ema20m5 >= ema50m5) continue;
        }
      }

      const atrM15 = calcATR(m15Slice, ATR_PERIOD);
      if (atrM15 <= 0) continue;

      // Zone check
      const range = Math.abs(fib.swingHigh - fib.swingLow);
      let lo: number, hi: number;
      if (dir === "Bearish") {
        lo = fib.swingLow + range * 0.50;
        hi = fib.swingLow + range * 0.886;
      } else {
        lo = fib.swingHigh - range * 0.886;
        hi = fib.swingHigh - range * 0.50;
      }

      const candleTouchesZone = dir === "Bearish" ? closedM5.high >= lo : closedM5.low <= hi;
      if (!candleTouchesZone) continue;

      // ATR M5 filter
      const m5ATR = calcATR(m5Slice.slice(0, -1), ATR_PERIOD);
      if (m5ATR < atrM15 * M5_ATR_MIN_RATIO) continue;

      // M5 body filter: reject doji/indecision candles where body < 30% of full range
      const m5FullRange = closedM5.high - closedM5.low;
      const m5Body = Math.abs(closedM5.close - closedM5.open);
      if (m5FullRange > 0 && m5Body < m5FullRange * 0.3) continue;

      // Candlestick patterns
      const isRejection = checkRejection(closedM5, dir, fib);
      const isEngulfing = checkEngulfing(prevM5, closedM5, dir);
      if (!isRejection && !isEngulfing) continue;

      const confirmationType = isEngulfing ? "engulfing" : "rejection";
      const sl = dir === "Bullish" ? fib.swingLow : fib.swingHigh;
      const entryPrice = closedM5.close;
      const slDistance = Math.abs(entryPrice - sl);

      // Task 2: minimum SL distance filter — 0.3× ATR M15 and hard 2.0 point floor
      if (slDistance < atrM15 * 0.3) continue;
      if (slDistance < 2.0) continue;

      // Task 3: TP2 = Fib 127.2% + 0.5× ATR M15 (more reachable than 161.8%)
      const tp2 = dir === "Bearish"
        ? fib.swingLow - range * 0.272 - atrM15 * 0.5
        : fib.swingHigh + range * 0.272 + atrM15 * 0.5;

      // TP1: minimum 1:1 RR from entry (SL distance), clamped to not exceed TP2
      const tp1Raw = dir === "Bearish" ? entryPrice - slDistance : entryPrice + slDistance;
      const tp1 = dir === "Bearish"
        ? Math.max(tp1Raw, tp2)  // for SELL: tp1 must not go below tp2 (tp2 is lower)
        : Math.min(tp1Raw, tp2); // for BUY:  tp1 must not exceed tp2 (tp2 is higher)

      const tp1Dist = Math.abs(tp1 - entryPrice);
      const tp2Dist = Math.abs(tp2 - entryPrice);
      const rr1 = Math.round((tp1Dist / slDistance) * 100) / 100;
      const rr2 = Math.round((tp2Dist / slDistance) * 100) / 100;

      // FIX Bug #2: filter sinyal dengan RR2 < minimum (misalnya TP2 terlalu dekat)
      if (rr2 < MIN_RR2) continue;

      // Confluence detection: check if any part of the 61.8%–78.6% entry zone
      // overlaps within ±2 pts of a round number or ±3 pts of a recent swing high/low
      const zoneL = dir === "Bearish" ? fib.swingLow + range * 0.618 : fib.swingHigh - range * 0.786;
      const zoneH = dir === "Bearish" ? fib.swingLow + range * 0.786 : fib.swingHigh - range * 0.618;
      const nearRound = [25, 50].some((step) => {
        const nearestL = Math.round(zoneL / step) * step;
        const nearestH = Math.round(zoneH / step) * step;
        return Math.abs(zoneL - nearestL) <= 2 || Math.abs(zoneH - nearestH) <= 2;
      });
      const swingPoints: number[] = [];
      if (swings.bullish) { swingPoints.push(swings.bullish.swingHigh, swings.bullish.swingLow); }
      if (swings.bearish) { swingPoints.push(swings.bearish.swingHigh, swings.bearish.swingLow); }
      const nearSwing = swingPoints.some((p) => p >= zoneL - 3 && p <= zoneH + 3);
      const confluence = nearRound || nearSwing;

      // Task 5: session tag
      const sessionTag: "active" | "low_confidence" = isActiveSession(closedM5.epoch * 1000) ? "active" : "low_confidence";

      // ADX regime filter — strictly skip signal generation if not trending.
      // Non-trending setups are evaluated as shadow stats for comparison only.
      if (regime !== "trending") {
        if (!seenShadowIds.has(sigId)) {
          seenShadowIds.add(sigId);
          const shadowRes = evaluateOutcome(
            { trend: dir, entryPrice, stopLoss: sl, takeProfit1: tp1, takeProfit2: tp2, signalEpoch: closedM5.epoch },
            m5All
          );
          shadowStats.push({ regime, outcome: shadowRes.outcome });
        }
        continue;
      }

      // Signal valid — register tracking slot
      seenSignalIds.add(sigId);
      activeTracker.id = sigId;
      activeTracker.anchor = swing.anchorEpoch;

      // Resolve outcome
      const resolution = evaluateOutcome(
        { trend: dir, entryPrice, stopLoss: sl, takeProfit1: tp1, takeProfit2: tp2, signalEpoch: closedM5.epoch },
        m5All
      );

      const bsig: BacktestSignal = {
        id: sigId,
        trend: dir,
        entryPrice,
        stopLoss: sl,
        takeProfit1: tp1,
        takeProfit2: tp2,
        rr1,
        rr2,
        signalEpoch: closedM5.epoch,
        confirmationType,
        sessionTag,
        anchorEpoch: swing.anchorEpoch,
        confluence,
        outcome: resolution.outcome,
        resolvedEpoch: resolution.resolvedEpoch,
        resolutionNote: resolution.resolutionNote,
        mae: resolution.mae,
        regime,
      };

      signals.push(bsig);

      const timeStr = new Date(closedM5.epoch * 1000).toISOString().replace("T", " ").slice(0, 19);
      const outcomeIcon =
        resolution.outcome === "win_tp2"       ? "🏆 TP2" :
        resolution.outcome === "win_breakeven" ? "🔒 BEP" :
        resolution.outcome === "loss"          ? "❌ SL " : "⏳ EXP";
      const dir2 = dir === "Bullish" ? "BUY " : "SELL";
      const sessFlag = sessionTag === "low_confidence" ? " [⚠ LOW_CONF]" : "";
      const confFlag = confluence ? " [✦ CONF]" : "";
      console.log(
        `  ${outcomeIcon} | ${timeStr} | ${dir2} | Entry: ${entryPrice.toFixed(2)} | SL: ${sl.toFixed(2)} | TP1: ${tp1.toFixed(2)} | TP2: ${tp2.toFixed(2)} | RR: 1:${rr1}/1:${rr2} | MAE: ${resolution.mae.toFixed(2)} pts | ${confirmationType.toUpperCase()}${sessFlag}${confFlag} | ${resolution.resolutionNote}`
      );
    }
  }

  // ─── Summary ──────────────────────────────────────────────────────────────
  const isWin = (s: BacktestSignal) => s.outcome === "win_tp2" || s.outcome === "win_breakeven";
  const isShadowWin = (s: { outcome: string }) => s.outcome === "win_tp2" || s.outcome === "win_breakeven";

  // All signals in `signals` are trending-only (regime = "trending")
  // Shadow stats hold non-trending candidates for comparison
  const activeSessionSigs = signals.filter((s) => s.sessionTag === "active");
  const lowConfSigs       = signals.filter((s) => s.sessionTag === "low_confidence");

  // Jika --active-only: hanya hitung sinyal di session aktif untuk winrate utama
  const evalSignals = FILTER_SESSION ? activeSessionSigs : signals;

  const total   = evalSignals.length;
  const winTP2  = evalSignals.filter((s) => s.outcome === "win_tp2").length;
  const winBEP  = evalSignals.filter((s) => s.outcome === "win_breakeven").length;
  const wins    = evalSignals.filter(isWin).length;
  const losses  = evalSignals.filter((s) => s.outcome === "loss").length;
  const expired = evalSignals.filter((s) => s.outcome === "expired").length;
  const resolved = wins + losses;
  const winRate = resolved > 0 ? ((wins / resolved) * 100).toFixed(1) : "N/A";
  const winRateAll = total > 0 ? ((wins / total) * 100).toFixed(1) : "N/A";

  // Expected value (per 1R risk): win_tp2 avg RR2 - loss * 1 (1R)
  const avgRR2 = evalSignals.length > 0 ? evalSignals.reduce((a, s) => a + s.rr2, 0) / evalSignals.length : 0;
  const ev = resolved > 0
    ? (((wins / resolved) * avgRR2) - ((losses / resolved) * 1.0)).toFixed(2)
    : "N/A";

  const activeWins = activeSessionSigs.filter(isWin).length;
  const activeResolved = activeSessionSigs.filter((s) => s.outcome === "loss" || isWin(s)).length;
  const lowConfWins = lowConfSigs.filter(isWin).length;
  const lowConfResolved = lowConfSigs.filter((s) => s.outcome === "loss" || isWin(s)).length;

  const buySignals  = evalSignals.filter((s) => s.trend === "Bullish");
  const sellSignals = evalSignals.filter((s) => s.trend === "Bearish");
  const buyWins  = buySignals.filter(isWin).length;
  const sellWins = sellSignals.filter(isWin).length;

  const rejSignals = evalSignals.filter((s) => s.confirmationType === "rejection");
  const engSignals = evalSignals.filter((s) => s.confirmationType === "engulfing");
  const rejWins = rejSignals.filter(isWin).length;
  const engWins = engSignals.filter(isWin).length;

  const wRate = (w: number, t: number) => t > 0 ? `${((w / t) * 100).toFixed(1)}%` : "N/A";

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log(`  HASIL BACKTEST — XAUUSD — ${DAYS_WINDOW} HARI TERAKHIR${FILTER_SESSION ? " [ACTIVE SESSION ONLY]" : ""}`);
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Total sinyal dievaluasi: ${total}${!FILTER_SESSION ? ` (active: ${activeSessionSigs.length}, low_conf: ${lowConfSigs.length})` : ""}`);
  console.log(`  Win (TP2)              : ${winTP2}`);
  console.log(`  Win (Breakeven)        : ${winBEP}`);
  console.log(`  Total Win              : ${wins}`);
  console.log(`  Loss (SL)              : ${losses}`);
  console.log(`  Expired (>${MAX_SIGNAL_LOOKAHEAD_BARS / 12}jam)         : ${expired}`);
  console.log("───────────────────────────────────────────────────────────────");
  const [ciLow, ciHigh] = wilsonCI(wins, resolved);
  const ciStr = resolved > 0 ? ` [CI: ${(ciLow * 100).toFixed(0)}%–${(ciHigh * 100).toFixed(0)}%]` : "";
  console.log(`  WINRATE (vs resolved)  : ${winRate === "N/A" ? "N/A" : `${winRate}%`}${ciStr} [${wins}/${resolved}]`);
  console.log(`  WINRATE (vs semua)     : ${winRateAll === "N/A" ? "N/A" : `${winRateAll}%`}   [${wins}/${total}]`);
  if (resolved < 20) {
    console.log(`  ⚠ Sampel terlalu kecil — hasil belum signifikan secara statistik`);
  }
  console.log(`  Expected Value / trade : ${ev}R  (avg RR2=${avgRR2.toFixed(2)})`);
  console.log("───────────────────────────────────────────────────────────────");
  console.log(`  Session breakdown:`);
  console.log(`    Active (London+NY) : ${activeSessionSigs.length} sinyal, ${activeWins} win — WR ${wRate(activeWins, activeResolved)} (vs resolved)`);
  console.log(`    Low confidence     : ${lowConfSigs.length} sinyal, ${lowConfWins} win — WR ${wRate(lowConfWins, lowConfResolved)} (vs resolved)`);
  console.log("───────────────────────────────────────────────────────────────");
  console.log(`  BUY  signals: ${buySignals.length} total, ${buyWins} win (${wRate(buyWins, buySignals.length)})`);
  console.log(`  SELL signals: ${sellSignals.length} total, ${sellWins} win (${wRate(sellWins, sellSignals.length)})`);
  console.log("───────────────────────────────────────────────────────────────");
  console.log(`  Pin Bar   : ${rejSignals.length} total, ${rejWins} win (${wRate(rejWins, rejSignals.length)})`);
  console.log(`  Engulfing : ${engSignals.length} total, ${engWins} win (${wRate(engWins, engSignals.length)})`);
  console.log("───────────────────────────────────────────────────────────────");
  // ADX regime comparison: trending (passed filter) vs non-trending shadow stats
  const rangingShadow = shadowStats.filter((s) => s.regime === "ranging");
  const unknownShadow = shadowStats.filter((s) => s.regime === "unknown");
  const trendingWins  = evalSignals.filter(isWin).length;
  const trendingRes   = evalSignals.filter((s) => s.outcome === "loss" || isWin(s)).length;
  const rangingWins   = rangingShadow.filter(isShadowWin).length;
  const unknownWins   = unknownShadow.filter(isShadowWin).length;
  const rangingRes    = rangingShadow.filter((s) => s.outcome === "loss" || isShadowWin(s)).length;
  const unknownRes    = unknownShadow.filter((s) => s.outcome === "loss" || isShadowWin(s)).length;
  const nonTrendTotal = shadowStats.length;
  const nonTrendWins  = shadowStats.filter(isShadowWin).length;
  const nonTrendRes   = shadowStats.filter((s) => s.outcome === "loss" || isShadowWin(s)).length;
  console.log(`  ADX Regime breakdown (trending = generated; ranging/unknown = shadow stats):`);
  console.log(`    Trending (ADX>25) [✓ sinyal aktif]: ${evalSignals.length} sinyal, ${trendingWins} win — WR ${wRate(trendingWins, trendingRes)} (vs resolved)`);
  console.log(`    Ranging  (ADX<20) [✗ filter shadow]: ${rangingShadow.length} kandidat, ${rangingWins} win — WR ${wRate(rangingWins, rangingRes)} (vs resolved)`);
  console.log(`    Unknown  (20-25)  [✗ filter shadow]: ${unknownShadow.length} kandidat, ${unknownWins} win — WR ${wRate(unknownWins, unknownRes)} (vs resolved)`);
  console.log(`    Non-trending total (shadow):          ${nonTrendTotal} kandidat, ${nonTrendWins} win — WR ${wRate(nonTrendWins, nonTrendRes)} (vs resolved)`);
  if (evalSignals.length > 0 && nonTrendTotal > 0) {
    const trendingWR = trendingRes > 0 ? (trendingWins / trendingRes * 100) : 0;
    const nonTrendWR = nonTrendRes  > 0 ? (nonTrendWins  / nonTrendRes  * 100) : 0;
    const diff = trendingWR - nonTrendWR;
    const verdict = diff > 5 ? "✓ ADX filter meningkatkan WR" : diff < -5 ? "✗ ADX filter menurunkan WR" : "≈ ADX filter tidak signifikan";
    console.log(`    Filter verdict: ${verdict} (trending ${trendingWR.toFixed(1)}% vs non-trending ${nonTrendWR.toFixed(1)}%, delta ${diff > 0 ? "+" : ""}${diff.toFixed(1)}%)`);
  }
  console.log("═══════════════════════════════════════════════════════════════\n");

  if (signals.length === 0) {
    console.log(`  ⚠  Tidak ada sinyal terbentuk dalam ${DAYS_WINDOW} hari terakhir.`);
    console.log("  Kemungkinan kondisi: pasar sideways / tidak memenuhi kriteria EMA50/fib/pattern.\n");
  }

  if (SAVE_RESULTS) {
    const resultsDir = path.join(__dirname, "results");
    if (!fs.existsSync(resultsDir)) {
      fs.mkdirSync(resultsDir, { recursive: true });
    }

    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const dateStr =
      `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
      `_${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
    const filename = `backtest_${dateStr}.json`;
    const filepath = path.join(resultsDir, filename);

    const resolvedCount = evalSignals.filter((s) => s.outcome === "loss" || isWin(s)).length;
    const winsCount = evalSignals.filter(isWin).length;

    const output = {
      metadata: {
        period: `${new Date(startEpoch * 1000).toISOString()} → ${new Date(nowEpoch * 1000).toISOString()}`,
        days: DAYS_WINDOW,
        totalSignals: evalSignals.length,
        winrate: resolvedCount > 0 ? parseFloat(((winsCount / resolvedCount) * 100).toFixed(2)) : null,
        ev: ev === "N/A" ? null : parseFloat(ev),
      },
      signals: evalSignals,
    };

    fs.writeFileSync(filepath, JSON.stringify(output, null, 2), "utf-8");
    console.log(`  ✓ Results saved to: ${filepath}\n`);
  }
}

runBacktest().catch((err) => {
  console.error("Backtest error:", err);
  process.exit(1);
});
