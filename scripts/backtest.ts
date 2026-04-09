/**
 * LIBARTIN Backtest Script
 * Mengambil data historis 24 jam XAUUSD dari Deriv API,
 * lalu memutar ulang bar-by-bar menggunakan logika strategi yang sama.
 */

import WebSocket from "ws";
import * as fs from "fs";
import * as path from "path";
import { detectMarketRegime, MarketRegime } from "../shared/marketRegime";
// Masalah 8c: Import semua helpers dari shared/indicators.ts — sama persis dengan live engine
import {
  Candle, FibLevels, SwingResult,
  calcEMA, calcATR, getTrend,
  findSwings, calcFib, checkRejection, checkEngulfing,
  isActiveSession,
} from "../shared/indicators";

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
const MIN_RR2 = 1.5;                  // Minimum RR di TP2 agar sinyal layak diambil

// ─── CLI Args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DAYS_WINDOW = (() => { const d = args.find((a) => a.startsWith("--days=")); if (!d) return 7; const n = parseInt(d.split("=")[1]); return Math.min(30, Math.max(1, isNaN(n) ? 7 : n)); })();
const FILTER_SESSION = args.includes("--active-only"); // hanya hitung active session di winrate utama
const SAVE_RESULTS  = args.includes("--save");         // export results to JSON file
const WALK_FORWARD  = args.includes("--walk-forward"); // walk-forward validation mode

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

      // Minimum Fibonacci range: swing harus setidaknya 1× ATR M15 (sinkron dengan live engine)
      const range = Math.abs(fib.swingHigh - fib.swingLow);
      if (range < atrM15 * 1.0) continue;

      let lo: number, hi: number;
      if (dir === "Bearish") {
        lo = fib.swingLow + range * 0.50;
        hi = fib.swingLow + range * 0.886;
      } else {
        lo = fib.swingHigh - range * 0.886;
        hi = fib.swingHigh - range * 0.50;
      }

      // Zone check: candle wick must be INSIDE the fib zone (50%–88.6%), not just touch one boundary
      // Bearish: high must enter zone from below (between lo and hi + 15% tolerance)
      // Bullish: low must enter zone from above (between lo - 15% tolerance and hi)
      const zoneTol = (hi - lo) * 0.15;
      const candleTouchesZone = dir === "Bearish"
        ? closedM5.high >= lo && closedM5.high <= hi + zoneTol
        : closedM5.low  <= hi && closedM5.low  >= lo - zoneTol;
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

      // Engulfing confluence gate — sinkron dengan live engine:
      // Engulfing WAJIB near round number (.25/.50) ATAU near swing point M5 terdekat
      if (isEngulfing && !isRejection) {
        const entryRef = closedM5.close;
        const nearRoundForEngulf = [25, 50].some((step) => {
          const nearest = Math.round(entryRef / step) * step;
          return Math.abs(entryRef - nearest) <= 2;
        });
        const recentM5slice = m5Slice.slice(-12, -2);
        const nearSwingM5 = [...recentM5slice.map((c) => c.high), ...recentM5slice.map((c) => c.low)].some(
          (p) => Math.abs(p - entryRef) <= 3
        );
        if (!nearRoundForEngulf && !nearSwingM5) continue;
      }

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

      // Filter sinyal dengan RR2 < minimum (misalnya TP2 terlalu dekat)
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

      // ADX regime: informational only — regime field is recorded on every signal.
      // No longer used to block signal generation; signals pass through regardless of ADX.

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

  // All signals pass through regardless of ADX regime; regime is recorded per-signal for analysis
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
  // ADX Regime breakdown — informational only (no longer used as entry filter)
  const trendingSigs = evalSignals.filter((s) => s.regime === "trending");
  const rangingSigs  = evalSignals.filter((s) => s.regime === "ranging");
  const unknownSigs  = evalSignals.filter((s) => s.regime === "unknown");
  const trendingWins = trendingSigs.filter(isWin).length;
  const rangingWins  = rangingSigs.filter(isWin).length;
  const unknownWins  = unknownSigs.filter(isWin).length;
  const trendingRes  = trendingSigs.filter((s) => s.outcome === "loss" || isWin(s)).length;
  const rangingRes   = rangingSigs.filter((s) => s.outcome === "loss" || isWin(s)).length;
  const unknownRes   = unknownSigs.filter((s) => s.outcome === "loss" || isWin(s)).length;
  console.log(`  ADX Regime breakdown (info only — tidak lagi memblok sinyal):`);
  console.log(`    Trending (ADX>25): ${trendingSigs.length} sinyal, ${trendingWins} win — WR ${wRate(trendingWins, trendingRes)} (vs resolved)`);
  console.log(`    Ranging  (ADX<20): ${rangingSigs.length} sinyal,  ${rangingWins} win — WR ${wRate(rangingWins, rangingRes)} (vs resolved)`);
  console.log(`    Unknown  (20-25) : ${unknownSigs.length} sinyal,  ${unknownWins} win — WR ${wRate(unknownWins, unknownRes)} (vs resolved)`);
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

// ─── Walk-Forward Block Simulator ─────────────────────────────────────────────
// Runs the signal-generation + outcome-evaluation loop on a given slice of M5
// data (the out-of-sample block), using the full historical m15All and m5Context
// arrays as context (but only counting signals whose epoch falls within the block).
function simulateBlock(
  blockStart: number,
  blockEnd: number,
  m15All: Candle[],
  m5Context: Candle[], // full m5 history up to blockEnd (includes context before block)
): { signals: number; wins: number } {
  const signals: BacktestSignal[] = [];
  const seenSignalIds = new Set<string>();
  const activeBuyId:  { id: string | null; anchor: number | null } = { id: null, anchor: null };
  const activeSellId: { id: string | null; anchor: number | null } = { id: null, anchor: null };

  function isResolved(sig: BacktestSignal, allM5: Candle[], upToIdx: number): boolean {
    const start = allM5.findIndex((c) => c.epoch >= sig.signalEpoch);
    if (start < 0) return false;
    const isBull = sig.trend === "Bullish";
    let effectiveSL = sig.stopLoss;
    let tp1Locked = false;
    for (let j = start + 1; j <= upToIdx; j++) {
      const c = allM5[j];
      const tp2Hit = isBull ? c.high >= sig.takeProfit2 : c.low <= sig.takeProfit2;
      const tp1Hit = isBull ? c.high >= sig.takeProfit1 : c.low <= sig.takeProfit1;
      const slHit  = isBull ? c.low  <= effectiveSL     : c.high >= effectiveSL;
      if (tp2Hit) return true;
      if (!tp1Locked) {
        if (tp1Hit && !slHit) { tp1Locked = true; effectiveSL = sig.entryPrice; continue; }
        if (slHit) return true;
        if (tp1Hit && slHit) {
          const candleDir = c.close > c.open ? "bull" : "bear";
          if ((isBull && candleDir === "bull") || (!isBull && candleDir === "bear")) {
            tp1Locked = true; effectiveSL = sig.entryPrice; continue;
          }
          return true;
        }
      } else {
        if (slHit) return true;
      }
    }
    return false;
  }

  for (let i = 0; i < m5Context.length - 1; i++) {
    const m5Slice = m5Context.slice(0, i + 2);
    if (m5Slice.length < 3) continue;

    const closedM5 = m5Slice[m5Slice.length - 2];
    const prevM5   = m5Slice[m5Slice.length - 3];

    // Only score signals within the out-of-sample block
    if (closedM5.epoch < blockStart || closedM5.epoch > blockEnd) continue;

    const m15Slice = m15All.filter((c) => c.epoch <= closedM5.epoch);
    if (m15Slice.length < EMA50_PERIOD) continue;

    const regime = detectMarketRegime(m15Slice);
    const swings = findSwings(m15Slice);

    if (activeBuyId.id !== null) {
      const existing = signals.find((s) => s.id === activeBuyId.id);
      if (existing && isResolved(existing, m5Context, i)) {
        activeBuyId.id = null; activeBuyId.anchor = null;
      }
    }
    if (activeSellId.id !== null) {
      const existing = signals.find((s) => s.id === activeSellId.id);
      if (existing && isResolved(existing, m5Context, i)) {
        activeSellId.id = null; activeSellId.anchor = null;
      }
    }

    for (const dir of ["Bullish", "Bearish"] as const) {
      const swing = dir === "Bullish" ? swings.bullish : swings.bearish;
      if (!swing) continue;

      const activeTracker = dir === "Bullish" ? activeBuyId : activeSellId;
      if (activeTracker.anchor === swing.anchorEpoch || activeTracker.id !== null) continue;

      const fib = calcFib(swing.swingHigh, swing.swingLow, dir);
      const sigId = `${closedM5.epoch}_${dir}`;
      if (seenSignalIds.has(sigId)) continue;

      const m15Closes = m15Slice.map((c) => c.close);
      const ema50Arr = calcEMA(m15Closes, EMA50_PERIOD);
      if (ema50Arr.length === 0) continue;
      const ema50 = ema50Arr[ema50Arr.length - 1];
      const lastM15Close = m15Closes[m15Closes.length - 1];
      if (dir === "Bullish" && lastM15Close <= ema50) continue;
      if (dir === "Bearish" && lastM15Close >= ema50) continue;

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

      // Minimum Fibonacci range filter (sinkron dengan live engine)
      const range = Math.abs(fib.swingHigh - fib.swingLow);
      if (range < atrM15 * 1.0) continue;

      let lo: number, hi: number;
      if (dir === "Bearish") {
        lo = fib.swingLow + range * 0.50;
        hi = fib.swingLow + range * 0.886;
      } else {
        lo = fib.swingHigh - range * 0.886;
        hi = fib.swingHigh - range * 0.50;
      }

      // Zone check: wick must be inside the fib zone (50%–88.6%), same fix as main loop
      const zoneTolB = (hi - lo) * 0.15;
      const candleTouchesZone = dir === "Bearish"
        ? closedM5.high >= lo && closedM5.high <= hi + zoneTolB
        : closedM5.low  <= hi && closedM5.low  >= lo - zoneTolB;
      if (!candleTouchesZone) continue;

      const m5ATR = calcATR(m5Slice.slice(0, -1), ATR_PERIOD);
      if (m5ATR < atrM15 * M5_ATR_MIN_RATIO) continue;

      const m5FullRange = closedM5.high - closedM5.low;
      const m5Body = Math.abs(closedM5.close - closedM5.open);
      if (m5FullRange > 0 && m5Body < m5FullRange * 0.3) continue;

      const isRejection = checkRejection(closedM5, dir, fib);
      const isEngulfing  = checkEngulfing(prevM5, closedM5, dir);
      if (!isRejection && !isEngulfing) continue;

      // Engulfing confluence gate (sinkron dengan live engine)
      if (isEngulfing && !isRejection) {
        const entryRefWF = closedM5.close;
        const nearRoundWF = [25, 50].some((step) => {
          const nearest = Math.round(entryRefWF / step) * step;
          return Math.abs(entryRefWF - nearest) <= 2;
        });
        const recentWF = m5Slice.slice(-12, -2);
        const nearSwingWF = [...recentWF.map((c) => c.high), ...recentWF.map((c) => c.low)].some(
          (p) => Math.abs(p - entryRefWF) <= 3
        );
        if (!nearRoundWF && !nearSwingWF) continue;
      }

      const confirmationType = isEngulfing ? "engulfing" : "rejection";
      const sl = dir === "Bullish" ? fib.swingLow : fib.swingHigh;
      const entryPrice = closedM5.close;
      const slDistance = Math.abs(entryPrice - sl);

      if (slDistance < atrM15 * 0.3) continue;
      if (slDistance < 2.0) continue;

      const tp2 = dir === "Bearish"
        ? fib.swingLow - range * 0.272 - atrM15 * 0.5
        : fib.swingHigh + range * 0.272 + atrM15 * 0.5;

      const tp1Raw = dir === "Bearish" ? entryPrice - slDistance : entryPrice + slDistance;
      const tp1 = dir === "Bearish"
        ? Math.max(tp1Raw, tp2)
        : Math.min(tp1Raw, tp2);

      const tp1Dist = Math.abs(tp1 - entryPrice);
      const tp2Dist = Math.abs(tp2 - entryPrice);
      const rr1 = Math.round((tp1Dist / slDistance) * 100) / 100;
      const rr2 = Math.round((tp2Dist / slDistance) * 100) / 100;

      if (rr2 < MIN_RR2) continue;

      // ADX no longer blocks signal generation (same as main backtest loop)

      seenSignalIds.add(sigId);
      activeTracker.id = sigId;
      activeTracker.anchor = swing.anchorEpoch;

      const sessionTag: "active" | "low_confidence" = isActiveSession(closedM5.epoch * 1000) ? "active" : "low_confidence";

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

      const resolution = evaluateOutcome(
        { trend: dir, entryPrice, stopLoss: sl, takeProfit1: tp1, takeProfit2: tp2, signalEpoch: closedM5.epoch },
        m5Context
      );

      const bsig: BacktestSignal = {
        id: sigId, trend: dir, entryPrice, stopLoss: sl, takeProfit1: tp1, takeProfit2: tp2,
        rr1, rr2, signalEpoch: closedM5.epoch, confirmationType, sessionTag,
        anchorEpoch: swing.anchorEpoch, confluence,
        outcome: resolution.outcome, resolvedEpoch: resolution.resolvedEpoch,
        resolutionNote: resolution.resolutionNote, mae: resolution.mae, regime,
      };
      signals.push(bsig);
    }
  }

  const isWin = (s: BacktestSignal) => s.outcome === "win_tp2" || s.outcome === "win_breakeven";
  return { signals: signals.length, wins: signals.filter(isWin).length };
}

// ─── Walk-Forward Main ─────────────────────────────────────────────────────────
async function runWalkForward() {
  const NUM_BLOCKS = 6;
  if (DAYS_WINDOW < NUM_BLOCKS) {
    console.error(`  ✗ --walk-forward requires at least ${NUM_BLOCKS} days (--days=${DAYS_WINDOW} is too small). Use --days=30.`);
    process.exit(1);
  }
  const BLOCK_DAYS = Math.floor(DAYS_WINDOW / NUM_BLOCKS); // 5 days each for --days=30

  const nowEpoch    = Math.floor(Date.now() / 1000);
  const startEpoch  = nowEpoch - DAYS_WINDOW * 24 * 3600;

  // Shared M15 context: 300 M15 bars before the full window start
  const m15ContextStart = startEpoch - 300 * M15_GRAN;

  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  LIBARTIN WALK-FORWARD VALIDATION — XAUUSD — ${DAYS_WINDOW} HARI`);
  console.log(`  Blocks: ${NUM_BLOCKS} × ${BLOCK_DAYS} day(s) each`);
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Full window: ${new Date(startEpoch * 1000).toISOString().slice(0, 10)} → ${new Date(nowEpoch * 1000).toISOString().slice(0, 10)}`);
  console.log("  Fetching shared M15 context...");

  let m15All: Candle[];
  try {
    m15All = await fetchCandlesChunked(M15_GRAN, m15ContextStart, nowEpoch);
    console.log(`  ✓ ${m15All.length} M15 candles received`);
  } catch (err) {
    console.error("  ✗ Failed to fetch M15 data:", (err as Error).message);
    process.exit(1);
  }

  // Build block boundaries
  const blockSizeSec = BLOCK_DAYS * 24 * 3600;
  const blocks: Array<{ blockStart: number; blockEnd: number; label: string }> = [];
  for (let b = 0; b < NUM_BLOCKS; b++) {
    const blockStart = startEpoch + b * blockSizeSec;
    const blockEnd   = b === NUM_BLOCKS - 1 ? nowEpoch : blockStart + blockSizeSec - 1;
    const label = `${new Date(blockStart * 1000).toISOString().slice(0, 10)} – ${new Date(blockEnd * 1000).toISOString().slice(0, 10)}`;
    blocks.push({ blockStart, blockEnd, label });
  }

  // M5 context start: 200 bars before full window start
  const m5ContextStart = startEpoch - 200 * M5_GRAN;

  console.log(`  Fetching M5 data for all ${NUM_BLOCKS} blocks in parallel...`);

  // Fetch M5 candles for each block in parallel (each block needs candles from m5ContextStart to blockEnd)
  let blockM5Data: Candle[][];
  try {
    blockM5Data = await Promise.all(
      blocks.map((b) => fetchCandlesChunked(M5_GRAN, m5ContextStart, b.blockEnd))
    );
    console.log(`  ✓ M5 data fetched for all blocks\n`);
  } catch (err) {
    console.error("  ✗ Failed to fetch M5 block data:", (err as Error).message);
    process.exit(1);
  }

  // Simulate each out-of-sample block
  interface BlockResult {
    block: number;
    label: string;
    signals: number;
    wins: number;
    winRate: number | null;
  }

  const results: BlockResult[] = [];

  for (let b = 0; b < NUM_BLOCKS; b++) {
    const { blockStart, blockEnd, label } = blocks[b];
    const m5Context = blockM5Data[b];
    console.log(`  Simulating Block ${b + 1}: ${label} ...`);
    const { signals, wins } = simulateBlock(blockStart, blockEnd, m15All, m5Context);
    const winRate = signals > 0 ? (wins / signals) * 100 : null;
    results.push({ block: b + 1, label, signals, wins, winRate });
  }

  // ─── Per-block table ────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  WALK-FORWARD RESULTS — Per Block");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(
    `  ${"Block".padEnd(6)} ${"Date Range".padEnd(26)} ${"Signals".padStart(7)} ${"Wins".padStart(5)} ${"Win Rate".padStart(9)}`
  );
  console.log("  " + "─".repeat(58));
  for (const r of results) {
    const wr = r.winRate !== null ? `${r.winRate.toFixed(1)}%` : "N/A";
    console.log(
      `  ${String(r.block).padEnd(6)} ${r.label.padEnd(26)} ${String(r.signals).padStart(7)} ${String(r.wins).padStart(5)} ${wr.padStart(9)}`
    );
  }
  console.log("  " + "─".repeat(58));

  // ─── Summary statistics ─────────────────────────────────────────────────────
  const validResults = results.filter((r) => r.winRate !== null);
  if (validResults.length === 0) {
    console.log("\n  ⚠ No signals found across all blocks — cannot compute summary statistics.\n");
    return;
  }

  const winRates = validResults.map((r) => r.winRate as number);
  const mean = winRates.reduce((a, b) => a + b, 0) / winRates.length;
  const variance = winRates.reduce((sum, wr) => sum + Math.pow(wr - mean, 2), 0) / winRates.length;
  const stdDev = Math.sqrt(variance);

  // Degradation trend: compare average WR of first half vs second half of blocks
  const half = Math.floor(validResults.length / 2);
  const firstHalfWR  = validResults.slice(0, half).reduce((a, r) => a + (r.winRate as number), 0) / (half || 1);
  const secondHalfWR = validResults.slice(half).reduce((a, r) => a + (r.winRate as number), 0) / ((validResults.length - half) || 1);
  const degradation  = secondHalfWR < firstHalfWR - 5; // >5pp drop in second half signals degradation

  console.log("\n  SUMMARY STATISTICS");
  console.log("  " + "─".repeat(58));
  console.log(`  Mean win rate      : ${mean.toFixed(1)}%`);
  console.log(`  Std dev (win rate) : ${stdDev.toFixed(1)}%`);
  const firstHalfLabels  = validResults.slice(0, half).map((r) => r.block);
  const secondHalfLabels = validResults.slice(half).map((r) => r.block);
  const fhRange = firstHalfLabels.length > 0 ? `Block${firstHalfLabels.length > 1 ? "s" : ""} ${firstHalfLabels[0]}–${firstHalfLabels[firstHalfLabels.length - 1]}` : "(none)";
  const shRange = secondHalfLabels.length > 0 ? `Block${secondHalfLabels.length > 1 ? "s" : ""} ${secondHalfLabels[0]}–${secondHalfLabels[secondHalfLabels.length - 1]}` : "(none)";
  console.log(`  First-half avg WR  : ${firstHalfWR.toFixed(1)}%  (${fhRange})`);
  console.log(`  Second-half avg WR : ${secondHalfWR.toFixed(1)}%  (${shRange})`);
  if (degradation) {
    console.log(`  ⚠ DEGRADATION DETECTED — win rate drops by ${(firstHalfWR - secondHalfWR).toFixed(1)}pp in later blocks.`);
    console.log(`     This may indicate overfitting to earlier market conditions.`);
  } else {
    console.log(`  ✓ No significant degradation trend detected across blocks.`);
  }
  console.log("═══════════════════════════════════════════════════════════════\n");
}

// ─── Entry Point ───────────────────────────────────────────────────────────────
if (WALK_FORWARD) {
  runWalkForward().catch((err) => {
    console.error("Walk-forward error:", err);
    process.exit(1);
  });
} else {
  runBacktest().catch((err) => {
    console.error("Backtest error:", err);
    process.exit(1);
  });
}
