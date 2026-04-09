import WebSocket from "ws";
import { calcATR, findSwings, Candle } from "../shared/indicators";

const DERIV_WS_URL = "wss://ws.binaryws.com/websockets/v3?app_id=1089";

function fetchCandles(gran: number, start: number, end: number): Promise<Candle[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(DERIV_WS_URL);
    const to = setTimeout(() => { ws.terminate(); reject(new Error("timeout")); }, 30000);
    ws.on("open", () => ws.send(JSON.stringify({ ticks_history: "frxXAUUSD", start, end, granularity: gran, style: "candles", adjust_start_time: 1 })));
    ws.on("message", (d: Buffer) => {
      const msg = JSON.parse(d.toString());
      if (msg.error) { clearTimeout(to); ws.terminate(); reject(new Error(msg.error.message)); return; }
      if (msg.msg_type === "candles") { clearTimeout(to); ws.terminate(); resolve(msg.candles.map((c: any) => ({ open: +c.open, high: +c.high, low: +c.low, close: +c.close, epoch: c.epoch }))); }
    });
    ws.on("error", (e: Error) => { clearTimeout(to); reject(e); });
  });
}

async function main() {
  const now = Math.floor(Date.now() / 1000);
  const start = now - 10 * 24 * 3600;
  console.log("Fetching M15...");
  const m15 = await fetchCandles(900, start, now);
  console.log("M15 total:", m15.length, "candles");

  const atr = calcATR(m15, 14);
  console.log(`ATR14 M15: ${atr.toFixed(2)} pts`);

  const LOOKBACK = Math.min(m15.length, 120);
  const slice = m15.slice(-LOOKBACK);
  const n = slice.length;

  // Count fractals
  let h5 = 0, l5 = 0, h1 = 0, l1 = 0;
  const idx5h: number[] = [], idx5l: number[] = [];
  for (let i = 2; i < n - 2; i++) {
    if (slice[i].high > slice[i-1].high && slice[i].high > slice[i-2].high && slice[i].high > slice[i+1].high && slice[i].high > slice[i+2].high) { h5++; idx5h.push(i); }
    if (slice[i].low < slice[i-1].low && slice[i].low < slice[i-2].low && slice[i].low < slice[i+1].low && slice[i].low < slice[i+2].low) { l5++; idx5l.push(i); }
  }
  for (let i = 1; i < n - 1; i++) {
    if (slice[i].high > slice[i-1].high && slice[i].high > slice[i+1].high) h1++;
    if (slice[i].low < slice[i-1].low && slice[i].low < slice[i+1].low) l1++;
  }
  console.log(`\n5-bar fractal: ${h5} highs, ${l5} lows`);
  console.log(`1-bar fractal (old): ${h1} highs, ${l1} lows`);

  // Test impulse pairs with different thresholds for BUY direction
  let tested = 0, ok30 = 0, ok40 = 0, ok50 = 0, failedRange = 0, failedSpan = 0;
  for (let hi = idx5h.length - 1; hi >= 0; hi--) {
    for (let li = idx5l.length - 1; li >= 0; li--) {
      const hIdx = idx5h[hi], lIdx = idx5l[li];
      if (lIdx >= hIdx) continue;
      const span = hIdx - lIdx;
      if (span < 3 || span > 40) { failedSpan++; continue; }
      const range = slice[hIdx].high - slice[lIdx].low;
      if (range < atr * 0.3) { failedRange++; continue; }
      tested++;
      let max30 = slice[lIdx].low, p30 = true;
      let max40 = slice[lIdx].low, p40 = true;
      let max50 = slice[lIdx].low, p50 = true;
      for (let j = lIdx; j <= hIdx; j++) {
        max30 = Math.max(max30, slice[j].high); if (slice[j].low < max30 - range * 0.30) p30 = false;
        max40 = Math.max(max40, slice[j].high); if (slice[j].low < max40 - range * 0.40) p40 = false;
        max50 = Math.max(max50, slice[j].high); if (slice[j].low < max50 - range * 0.50) p50 = false;
      }
      if (p30) ok30++; if (p40) ok40++; if (p50) ok50++;
    }
  }
  console.log(`\nBullish impulse pairs: tested=${tested}, failedSpan=${failedSpan}, failedRange=${failedRange}`);
  console.log(`  Clean at 30%: ${ok30}`);
  console.log(`  Clean at 40%: ${ok40}`);
  console.log(`  Clean at 50%: ${ok50}`);

  // Final: what does findSwings return now?
  const swings = findSwings(m15, atr);
  console.log(`\nfindSwings result (current code):`);
  console.log("  Bullish:", swings.bullish ? `H=${swings.bullish.swingHigh.toFixed(2)} L=${swings.bullish.swingLow.toFixed(2)} range=${(swings.bullish.swingHigh-swings.bullish.swingLow).toFixed(2)}` : "NULL");
  console.log("  Bearish:", swings.bearish ? `H=${swings.bearish.swingHigh.toFixed(2)} L=${swings.bearish.swingLow.toFixed(2)} range=${(swings.bearish.swingHigh-swings.bearish.swingLow).toFixed(2)}` : "NULL");
  
  // Test with minimum range filter 1× ATR
  if (swings.bullish) {
    const bRange = swings.bullish.swingHigh - swings.bullish.swingLow;
    console.log(`  Bullish range ${bRange.toFixed(2)} vs 1×ATR ${atr.toFixed(2)}: ${bRange >= atr ? "PASS ✓" : "FAIL ✗"}`);
  }
  if (swings.bearish) {
    const beRange = swings.bearish.swingHigh - swings.bearish.swingLow;
    console.log(`  Bearish range ${beRange.toFixed(2)} vs 1×ATR ${atr.toFixed(2)}: ${beRange >= atr ? "PASS ✓" : "FAIL ✗"}`);
  }
}

main().catch(console.error);
