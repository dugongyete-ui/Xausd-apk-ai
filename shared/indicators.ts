/**
 * shared/indicators.ts
 * Fungsi indikator teknikal yang digunakan bersama oleh:
 *  - server/derivService.ts (live signal engine)
 *  - scripts/backtest.ts (backtesting CLI)
 * Memastikan backtest selalu menguji logika yang sama dengan live app.
 */

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

export interface SwingResult {
  swingHigh: number;
  swingLow: number;
  anchorEpoch: number;
}

// ─── EMA ─────────────────────────────────────────────────────────────────────
export function calcEMA(closes: number[], period: number): number[] {
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

export function calcEMAFull(closes: number[], period: number): number[] {
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

// ─── ATR ─────────────────────────────────────────────────────────────────────
export function calcATR(candles: Candle[], period: number): number {
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

// ─── Fibonacci ────────────────────────────────────────────────────────────────
export function calcFib(swingHigh: number, swingLow: number, trend: "Bullish" | "Bearish"): FibLevels {
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

// ─── Swing Detection ──────────────────────────────────────────────────────────
// Menggunakan 5-bar fractal (2 candle kiri-kanan) untuk swing yang lebih solid.
// Span impulse: 3-40 candle. Range minimum: 0.3 × ATR M15.
// Retracement check: tracking running high/low untuk deteksi koreksi dalam impulse.
export function findSwings(
  candles: Candle[],
  atrM15 = 0
): { bullish: SwingResult | null; bearish: SwingResult | null } {
  const LOOKBACK = Math.min(candles.length, 120);
  const slice = candles.slice(-LOOKBACK);
  const n = slice.length;
  if (n < 12) return { bullish: null, bearish: null };

  // 5-bar fractal: candle ke-i adalah swing high jika high-nya lebih tinggi
  // dari 2 candle di kiri DAN 2 candle di kanan.
  const swingHighs: number[] = [];
  const swingLows: number[] = [];
  for (let i = 2; i < n - 2; i++) {
    const isSwingHigh =
      slice[i].high > slice[i - 1].high &&
      slice[i].high > slice[i - 2].high &&
      slice[i].high > slice[i + 1].high &&
      slice[i].high > slice[i + 2].high;
    const isSwingLow =
      slice[i].low < slice[i - 1].low &&
      slice[i].low < slice[i - 2].low &&
      slice[i].low < slice[i + 1].low &&
      slice[i].low < slice[i + 2].low;
    if (isSwingHigh) swingHighs.push(i);
    if (isSwingLow)  swingLows.push(i);
  }

  function isCleanImpulse(
    fromIdx: number, toIdx: number,
    fromPrice: number, toPrice: number,
    dir: "up" | "down"
  ): boolean {
    const span = toIdx - fromIdx;
    if (span < 3 || span > 40) return false;
    const range = Math.abs(toPrice - fromPrice);
    const minRange = atrM15 > 0 ? atrM15 * 0.3 : 5;
    if (range < minRange) return false;

    // Retracement check yang benar:
    // BUY: track running high — jika ada candle yang retraced >30% dari high tertinggi saat itu, tolak
    // SELL: track running low — jika ada candle yang rebound >30% dari low terendah saat itu, tolak
    let runningExtreme = fromPrice;
    for (let j = fromIdx; j <= toIdx; j++) {
      if (dir === "up") {
        runningExtreme = Math.max(runningExtreme, slice[j].high);
        if (slice[j].low < runningExtreme - range * 0.30) return false;
      } else {
        runningExtreme = Math.min(runningExtreme, slice[j].low);
        if (slice[j].high > runningExtreme + range * 0.30) return false;
      }
    }

    // Trending check: rata-rata close separuh kedua harus lebih tinggi/rendah dari separuh pertama
    const mid = fromIdx + Math.floor(span / 2);
    let sumA = 0, cntA = 0, sumB = 0, cntB = 0;
    for (let j = fromIdx; j <= toIdx; j++) {
      if (j <= mid) { sumA += slice[j].close; cntA++; }
      else          { sumB += slice[j].close; cntB++; }
    }
    if (cntA === 0 || cntB === 0) return false;
    const avgA = sumA / cntA;
    const avgB = sumB / cntB;
    if (dir === "up"   && avgB <= avgA) return false;
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

// ─── Pattern Detection ────────────────────────────────────────────────────────
export function checkRejection(candle: Candle, trend: "Bullish" | "Bearish", fib: FibLevels): boolean {
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
    if (candle.low < lo - (hi - lo) * 0.15) return false;
    return true;
  }
  if (candle.close >= candle.open) return false;
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  if (upperWick < body * 0.8) return false;
  if (candle.high < lo) return false;
  if (candle.high > hi + (hi - lo) * 0.15) return false;
  return true;
}

export function checkEngulfing(prev: Candle, curr: Candle, trend: "Bullish" | "Bearish"): boolean {
  const prevBody = Math.abs(prev.close - prev.open);
  const currBody = Math.abs(curr.close - curr.open);
  if (prevBody === 0 || currBody === 0) return false;
  if (currBody < prevBody * 0.70) return false;
  if (trend === "Bullish") {
    const prevBear = prev.close < prev.open;
    const currBull = curr.close > curr.open;
    if (!prevBear || !currBull) return false;
    const engulfTarget = prev.close + (prev.open - prev.close) * 0.65;
    return curr.close >= engulfTarget && curr.open <= prev.close + prevBody * 0.25;
  }
  const prevBull = prev.close > prev.open;
  const currBear = curr.close < curr.open;
  if (!prevBull || !currBear) return false;
  const engulfTarget = prev.close - (prev.close - prev.open) * 0.65;
  return curr.close <= engulfTarget && curr.open >= prev.close - prevBody * 0.25;
}

// ─── Trend ───────────────────────────────────────────────────────────────────
export function getTrend(m15Candles: Candle[], ema50Period = 50): "Bullish" | "Bearish" | "No Trade" | "Loading" {
  if (m15Candles.length < ema50Period) return "Loading";
  const closes = m15Candles.map((c) => c.close);
  const ema50Arr = calcEMA(closes, ema50Period);
  if (ema50Arr.length === 0) return "Loading";
  const ema50 = ema50Arr[ema50Arr.length - 1];
  const last = closes[closes.length - 1];
  if (last > ema50) return "Bullish";
  if (last < ema50) return "Bearish";
  return "No Trade";
}

// ─── Session Filter ───────────────────────────────────────────────────────────
// Masalah 6c: Exclude London open pertama 30 menit (07:00-07:30 UTC)
// dan NY open pertama 30 menit (13:00-13:30 UTC) sebagai "spike zone"
export function isActiveSession(epochMs: number): boolean {
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
