/**
 * LIBARTIN Backtest Script
 * Mengambil data historis 24 jam XAUUSD dari Deriv API,
 * lalu memutar ulang bar-by-bar menggunakan logika strategi yang sama.
 */

import WebSocket from "ws";

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
  outcome: "win_tp1" | "win_tp2" | "loss" | "expired";
  resolvedEpoch?: number;
  resolutionNote: string;
}

// ─── Constants ─────────────────────────────────────────────────────────────────
const DERIV_WS_URL = "wss://ws.binaryws.com/websockets/v3?app_id=1089";
const SYMBOL = "frxXAUUSD";
const M15_GRAN = 900;
const M5_GRAN = 300;
const EMA50_PERIOD = 50;
const ATR_PERIOD = 14;
const M5_ATR_MIN_RATIO = 0.5;
const MAX_SIGNAL_LOOKAHEAD_BARS = 60; // Max 60 M5 bars (~5 jam) untuk resolve outcome

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

// ─── Evaluate outcome of a signal given subsequent candles ─────────────────────
function evaluateOutcome(
  signal: { trend: "Bullish" | "Bearish"; entryPrice: number; stopLoss: number; takeProfit1: number; takeProfit2: number; signalEpoch: number },
  allM5Candles: Candle[]
): { outcome: "win_tp1" | "win_tp2" | "loss" | "expired"; resolvedEpoch?: number; resolutionNote: string } {
  const signalIdx = allM5Candles.findIndex((c) => c.epoch >= signal.signalEpoch);
  if (signalIdx < 0) return { outcome: "expired", resolutionNote: "candle not found" };

  const startIdx = signalIdx + 1;
  const endIdx = Math.min(startIdx + MAX_SIGNAL_LOOKAHEAD_BARS, allM5Candles.length);
  const isBull = signal.trend === "Bullish";

  for (let i = startIdx; i < endIdx; i++) {
    const c = allM5Candles[i];
    const tp2Hit = isBull ? c.high >= signal.takeProfit2 : c.low <= signal.takeProfit2;
    const tp1Hit = isBull ? c.high >= signal.takeProfit1 : c.low <= signal.takeProfit1;
    const slHit  = isBull ? c.low  <= signal.stopLoss    : c.high >= signal.stopLoss;

    // Check dalam satu candle: SL vs TP — pakai heuristic arah open candle
    if (tp2Hit && !slHit) return { outcome: "win_tp2", resolvedEpoch: c.epoch, resolutionNote: `TP2 hit @ bar ${i - signalIdx}` };
    if (tp1Hit && !slHit) return { outcome: "win_tp1", resolvedEpoch: c.epoch, resolutionNote: `TP1 hit @ bar ${i - signalIdx}` };
    if (slHit && !tp1Hit) return { outcome: "loss",    resolvedEpoch: c.epoch, resolutionNote: `SL hit @ bar ${i - signalIdx}` };
    // Both triggered same bar — determine by candle body direction
    if ((tp1Hit || tp2Hit) && slHit) {
      const candleDir = c.close > c.open ? "bull" : "bear";
      if ((isBull && candleDir === "bull") || (!isBull && candleDir === "bear")) {
        return { outcome: "win_tp1", resolvedEpoch: c.epoch, resolutionNote: `TP1+SL same bar, body favors entry @ bar ${i - signalIdx}` };
      } else {
        return { outcome: "loss", resolvedEpoch: c.epoch, resolutionNote: `TP1+SL same bar, body against entry @ bar ${i - signalIdx}` };
      }
    }
  }
  return { outcome: "expired", resolutionNote: `Belum resolve dalam ${MAX_SIGNAL_LOOKAHEAD_BARS} bar M5` };
}

// ─── Main Backtest ─────────────────────────────────────────────────────────────
async function runBacktest() {
  const nowEpoch = Math.floor(Date.now() / 1000);
  const startEpoch = nowEpoch - 24 * 3600; // 24 jam kebelakang

  // Butuh konteks M15 lebih panjang untuk swing detection (300 candle M15 = ~75 jam)
  const m15ContextStart = nowEpoch - 300 * M15_GRAN;

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  LIBARTIN BACKTEST — XAUUSD — 24 JAM TERAKHIR");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Periode  : ${new Date(startEpoch * 1000).toISOString()} → ${new Date(nowEpoch * 1000).toISOString()}`);
  console.log(`  Lookback M15 context: ${new Date(m15ContextStart * 1000).toISOString()}`);
  console.log("  Mengambil data dari Deriv API...\n");

  let m15All: Candle[];
  let m5All: Candle[];

  try {
    console.log("  [1/2] Mengambil candle M15 (konteks + 24 jam)...");
    m15All = await fetchCandles(M15_GRAN, m15ContextStart, nowEpoch);
    console.log(`        ✓ ${m15All.length} candle M15 diterima`);

    console.log("  [2/2] Mengambil candle M5 (24 jam + 200 konteks)...");
    const m5Start = nowEpoch - (24 * 3600) - (200 * M5_GRAN);
    m5All = await fetchCandles(M5_GRAN, m5Start, nowEpoch);
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

    const liveTrend = getTrend(m15Slice);
    const swings = findSwings(m15Slice);

    // Evaluate both directions
    for (const dir of ["Bullish", "Bearish"] as const) {
      const swing = dir === "Bullish" ? swings.bullish : swings.bearish;
      if (!swing) continue;

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

      // Candlestick patterns
      const isRejection = checkRejection(closedM5, dir, fib);
      const isEngulfing = checkEngulfing(prevM5, closedM5, dir);
      if (!isRejection && !isEngulfing) continue;

      // Signal valid!
      seenSignalIds.add(sigId);

      const confirmationType = isEngulfing ? "engulfing" : "rejection";
      const sl = dir === "Bullish" ? fib.swingLow : fib.swingHigh;
      const entryPrice = closedM5.close;
      const slDistance = Math.abs(entryPrice - sl);
      if (slDistance < atrM15 * 0.1) continue;

      // TP calculation
      const tp1FibLevel = dir === "Bearish" ? fib.swingLow - range * 0.272 : fib.swingHigh + range * 0.272;
      const tp1AtrLevel = dir === "Bearish" ? entryPrice - atrM15 * 1.0 : entryPrice + atrM15 * 1.0;
      const tp1 = dir === "Bearish" ? Math.max(tp1FibLevel, tp1AtrLevel) : Math.min(tp1FibLevel, tp1AtrLevel);
      const tp2 = dir === "Bearish" ? fib.swingLow - range * 0.618 : fib.swingHigh + range * 0.618;
      const tp1Dist = Math.abs(tp1 - entryPrice);
      const tp2Dist = Math.abs(tp2 - entryPrice);
      const rr1 = Math.round((tp1Dist / slDistance) * 100) / 100;
      const rr2 = Math.round((tp2Dist / slDistance) * 100) / 100;

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
        ...resolution,
      };

      signals.push(bsig);

      const timeStr = new Date(closedM5.epoch * 1000).toISOString().replace("T", " ").slice(0, 19);
      const outcomeIcon =
        resolution.outcome === "win_tp1" ? "✅ TP1" :
        resolution.outcome === "win_tp2" ? "🏆 TP2" :
        resolution.outcome === "loss"    ? "❌ SL " : "⏳ EXP";
      const dir2 = dir === "Bullish" ? "BUY " : "SELL";
      console.log(
        `  ${outcomeIcon} | ${timeStr} | ${dir2} | Entry: ${entryPrice.toFixed(2)} | SL: ${sl.toFixed(2)} | TP1: ${tp1.toFixed(2)} | TP2: ${tp2.toFixed(2)} | RR: 1:${rr1}/1:${rr2} | ${confirmationType.toUpperCase()} | ${resolution.resolutionNote}`
      );
    }
  }

  // ─── Summary ──────────────────────────────────────────────────────────────
  const total   = signals.length;
  const winTP1  = signals.filter((s) => s.outcome === "win_tp1").length;
  const winTP2  = signals.filter((s) => s.outcome === "win_tp2").length;
  const wins    = winTP1 + winTP2;
  const losses  = signals.filter((s) => s.outcome === "loss").length;
  const expired = signals.filter((s) => s.outcome === "expired").length;
  const resolved = wins + losses;
  const winRate = resolved > 0 ? ((wins / resolved) * 100).toFixed(1) : "N/A";
  const winRateAll = total > 0 ? ((wins / total) * 100).toFixed(1) : "N/A";

  const buySignals  = signals.filter((s) => s.trend === "Bullish");
  const sellSignals = signals.filter((s) => s.trend === "Bearish");
  const buyWins  = buySignals.filter((s) => s.outcome === "win_tp1" || s.outcome === "win_tp2").length;
  const sellWins = sellSignals.filter((s) => s.outcome === "win_tp1" || s.outcome === "win_tp2").length;

  const rejSignals = signals.filter((s) => s.confirmationType === "rejection");
  const engSignals = signals.filter((s) => s.confirmationType === "engulfing");
  const rejWins = rejSignals.filter((s) => s.outcome === "win_tp1" || s.outcome === "win_tp2").length;
  const engWins = engSignals.filter((s) => s.outcome === "win_tp1" || s.outcome === "win_tp2").length;

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  HASIL BACKTEST — XAUUSD — 24 JAM TERAKHIR");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Total sinyal    : ${total}`);
  console.log(`  Win (TP1)       : ${winTP1}`);
  console.log(`  Win (TP2)       : ${winTP2}`);
  console.log(`  Total Win       : ${wins}`);
  console.log(`  Loss (SL)       : ${losses}`);
  console.log(`  Expired (>5jam) : ${expired}`);
  console.log("───────────────────────────────────────────────────────────────");
  console.log(`  WINRATE (vs resolved)  : ${winRate}%   [${wins}/${resolved}]`);
  console.log(`  WINRATE (vs semua)     : ${winRateAll}%   [${wins}/${total}]`);
  console.log("───────────────────────────────────────────────────────────────");
  console.log(`  BUY  signals: ${buySignals.length} total, ${buyWins} win (${buySignals.length > 0 ? ((buyWins / buySignals.length) * 100).toFixed(1) : "N/A"}%)`);
  console.log(`  SELL signals: ${sellSignals.length} total, ${sellWins} win (${sellSignals.length > 0 ? ((sellWins / sellSignals.length) * 100).toFixed(1) : "N/A"}%)`);
  console.log("───────────────────────────────────────────────────────────────");
  console.log(`  Pin Bar     : ${rejSignals.length} total, ${rejWins} win (${rejSignals.length > 0 ? ((rejWins / rejSignals.length) * 100).toFixed(1) : "N/A"}%)`);
  console.log(`  Engulfing   : ${engSignals.length} total, ${engWins} win (${engSignals.length > 0 ? ((engWins / engSignals.length) * 100).toFixed(1) : "N/A"}%)`);
  console.log("═══════════════════════════════════════════════════════════════\n");

  if (total === 0) {
    console.log("  ⚠  Tidak ada sinyal terbentuk dalam 24 jam terakhir.");
    console.log("  Kemungkinan kondisi: pasar sideways / tidak memenuhi kriteria EMA50/fib/pattern.\n");
  }
}

runBacktest().catch((err) => {
  console.error("Backtest error:", err);
  process.exit(1);
});
