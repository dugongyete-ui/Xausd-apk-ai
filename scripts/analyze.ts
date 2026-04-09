/**
 * LIBARTIN Backtest Analyzer
 * Reads a backtest JSON export and prints deep statistical insights.
 *
 * Usage: npx tsx scripts/analyze.ts scripts/results/<file>.json
 */

import * as fs from "fs";
import * as path from "path";

// ─── Types ────────────────────────────────────────────────────────────────────
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
  regime: string;
}

interface BacktestJSON {
  metadata: {
    period: string;
    days: number;
    totalSignals: number;
    winrate: number | null;
    ev: number | null;
  };
  signals: BacktestSignal[];
}

// ─── CLI ──────────────────────────────────────────────────────────────────────
const filePath = process.argv[2];
if (!filePath) {
  console.error("Usage: npx tsx scripts/analyze.ts <path-to-backtest.json>");
  process.exit(1);
}

const resolved = path.resolve(filePath);
if (!fs.existsSync(resolved)) {
  console.error(`File not found: ${resolved}`);
  process.exit(1);
}

let data: BacktestJSON;
try {
  data = JSON.parse(fs.readFileSync(resolved, "utf-8"));
} catch (e) {
  console.error("Failed to parse JSON:", (e as Error).message);
  process.exit(1);
}

const { metadata, signals } = data;

if (!metadata || typeof metadata !== "object") {
  console.error("Invalid file: missing or malformed metadata object.");
  process.exit(1);
}
if (typeof metadata.days !== "number" || typeof metadata.period !== "string") {
  console.error("Invalid file: metadata must contain 'days' (number) and 'period' (string).");
  process.exit(1);
}
if (!Array.isArray(signals)) {
  console.error("Invalid file: missing signals array.");
  process.exit(1);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const isWin = (s: BacktestSignal) => s.outcome === "win_tp2" || s.outcome === "win_breakeven";

function pct(w: number, t: number): string {
  return t > 0 ? `${((w / t) * 100).toFixed(1)}%` : "N/A";
}

function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function bar(value: number, max: number, width = 30): string {
  if (max === 0) return "";
  const filled = Math.round((value / max) * width);
  return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
}

// ─── Section: Header ─────────────────────────────────────────────────────────
console.log("\n═══════════════════════════════════════════════════════════════");
console.log("  LIBARTIN BACKTEST DEEP ANALYSIS");
console.log("═══════════════════════════════════════════════════════════════");
console.log(`  File   : ${path.basename(resolved)}`);
console.log(`  Period : ${metadata.period}`);
console.log(`  Days   : ${metadata.days}`);
console.log(`  Signals: ${metadata.totalSignals}`);
console.log(`  Winrate: ${metadata.winrate !== null ? metadata.winrate + "%" : "N/A"}`);
console.log(`  EV     : ${metadata.ev !== null ? metadata.ev + "R" : "N/A"}`);

if (signals.length === 0) {
  console.log("\n  No signals to analyze.");
  process.exit(0);
}

// ─── Section 1: RR2 Distribution Histogram ───────────────────────────────────
console.log("\n───────────────────────────────────────────────────────────────");
console.log("  1. RR2 DISTRIBUTION (bucketed by 0.5)");
console.log("───────────────────────────────────────────────────────────────");

const rr2Values = signals.map((s) => s.rr2);
const minRR2 = Math.floor(Math.min(...rr2Values) * 2) / 2;
const maxRR2 = Math.ceil(Math.max(...rr2Values) * 2) / 2;

const buckets: Map<string, number> = new Map();
let bucketStart = minRR2;
while (bucketStart <= maxRR2) {
  const key = `${bucketStart.toFixed(1)}–${(bucketStart + 0.5).toFixed(1)}`;
  buckets.set(key, 0);
  bucketStart += 0.5;
}

for (const rr of rr2Values) {
  const bucket = Math.floor(rr * 2) / 2;
  const key = `${bucket.toFixed(1)}–${(bucket + 0.5).toFixed(1)}`;
  buckets.set(key, (buckets.get(key) ?? 0) + 1);
}

const maxCount = Math.max(...buckets.values());
for (const [label, count] of buckets) {
  const barStr = bar(count, maxCount, 30);
  console.log(`  ${label.padEnd(12)} | ${barStr} ${count}`);
}

// ─── Section 2: Win/Loss Streaks ─────────────────────────────────────────────
console.log("\n───────────────────────────────────────────────────────────────");
console.log("  2. WIN / LOSS STREAKS");
console.log("───────────────────────────────────────────────────────────────");

const resolved_signals = signals.filter(
  (s) => s.outcome === "win_tp2" || s.outcome === "win_breakeven" || s.outcome === "loss"
);

let longestWin = 0;
let longestLoss = 0;
let curWin = 0;
let curLoss = 0;

for (const s of resolved_signals) {
  if (isWin(s)) {
    curWin++;
    curLoss = 0;
    if (curWin > longestWin) longestWin = curWin;
  } else {
    curLoss++;
    curWin = 0;
    if (curLoss > longestLoss) longestLoss = curLoss;
  }
}

console.log(`  Longest win streak : ${longestWin}`);
console.log(`  Longest loss streak: ${longestLoss}`);

// ─── Section 3: Performance by Day of Week ───────────────────────────────────
console.log("\n───────────────────────────────────────────────────────────────");
console.log("  3. PERFORMANCE BY DAY OF WEEK");
console.log("───────────────────────────────────────────────────────────────");

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const dayMap: Map<number, BacktestSignal[]> = new Map();
for (let d = 0; d < 7; d++) dayMap.set(d, []);

for (const s of signals) {
  const dow = new Date(s.signalEpoch * 1000).getUTCDay();
  dayMap.get(dow)!.push(s);
}

console.log(
  `  ${"Day".padEnd(5)} | ${"Total".padStart(5)} | ${"Wins".padStart(4)} | ${"WR".padStart(6)} | ${"Avg RR2".padStart(7)}`
);
console.log("  ─────┼───────┼──────┼────────┼─────────");
for (let d = 1; d <= 7; d++) {
  const dow = d % 7;
  const sigs = dayMap.get(dow)!;
  const resolvedSigs = sigs.filter((s) => s.outcome !== "expired");
  const wins = sigs.filter(isWin).length;
  const resolvedWins = resolvedSigs.filter(isWin).length;
  const resolvedCount = resolvedSigs.filter((s) => s.outcome === "loss" || isWin(s)).length;
  const avgRR = avg(sigs.map((s) => s.rr2));
  console.log(
    `  ${DAY_NAMES[dow].padEnd(5)} | ${String(sigs.length).padStart(5)} | ${String(wins).padStart(4)} | ${pct(resolvedWins, resolvedCount).padStart(6)} | ${avgRR.toFixed(2).padStart(7)}`
  );
}

// ─── Section 4: Performance by UTC Hour ──────────────────────────────────────
console.log("\n───────────────────────────────────────────────────────────────");
console.log("  4. PERFORMANCE BY UTC HOUR (08:00–21:00)");
console.log("───────────────────────────────────────────────────────────────");

const hourMap: Map<number, BacktestSignal[]> = new Map();
for (let h = 8; h <= 21; h++) hourMap.set(h, []);

for (const s of signals) {
  const utcH = new Date(s.signalEpoch * 1000).getUTCHours();
  if (utcH >= 8 && utcH <= 21) {
    hourMap.get(utcH)!.push(s);
  }
}

console.log(
  `  ${"Hour".padEnd(6)} | ${"Total".padStart(5)} | ${"Wins".padStart(4)} | ${"WR".padStart(6)} | ${"Avg RR2".padStart(7)}`
);
console.log("  ──────┼───────┼──────┼────────┼─────────");
for (let h = 8; h <= 21; h++) {
  const sigs = hourMap.get(h)!;
  const wins = sigs.filter(isWin).length;
  const resolvedCount = sigs.filter((s) => s.outcome === "loss" || isWin(s)).length;
  const resolvedWins = sigs.filter((s) => (s.outcome === "loss" || isWin(s)) && isWin(s)).length;
  const avgRR = avg(sigs.map((s) => s.rr2));
  const hourLabel = `${String(h).padStart(2, "0")}:00`;
  console.log(
    `  ${hourLabel.padEnd(6)} | ${String(sigs.length).padStart(5)} | ${String(wins).padStart(4)} | ${pct(resolvedWins, resolvedCount).padStart(6)} | ${avgRR.toFixed(2).padStart(7)}`
  );
}

// ─── Section 5: Monte Carlo Max Drawdown ─────────────────────────────────────
console.log("\n───────────────────────────────────────────────────────────────");
console.log("  5. MONTE CARLO MAX DRAWDOWN (1000 iterations, 1R risk/trade)");
console.log("───────────────────────────────────────────────────────────────");

const resolvedForMC = signals.filter(
  (s) => s.outcome === "win_tp2" || s.outcome === "win_breakeven" || s.outcome === "loss"
);

if (resolvedForMC.length < 2) {
  console.log("  Not enough resolved signals for Monte Carlo simulation.");
} else {
  const pnlSamples: number[] = resolvedForMC.map((s) => {
    if (s.outcome === "win_tp2") return s.rr2;
    if (s.outcome === "win_breakeven") return 0;
    return -1;
  });

  const ITERATIONS = 1000;
  const maxDrawdowns: number[] = [];

  for (let iter = 0; iter < ITERATIONS; iter++) {
    let equity = 0;
    let peak = 0;
    let maxDD = 0;

    const n = pnlSamples.length;
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(Math.random() * n);
      equity += pnlSamples[idx];
      if (equity > peak) peak = equity;
      const dd = peak - equity;
      if (dd > maxDD) maxDD = dd;
    }
    maxDrawdowns.push(maxDD);
  }

  maxDrawdowns.sort((a, b) => a - b);

  const p10 = maxDrawdowns[Math.floor(ITERATIONS * 0.10)];
  const p50 = maxDrawdowns[Math.floor(ITERATIONS * 0.50)];
  const p90 = maxDrawdowns[Math.floor(ITERATIONS * 0.90)];

  console.log(`  Resolved signals used: ${resolvedForMC.length}`);
  console.log(`  Iterations           : ${ITERATIONS}`);
  console.log(`  Max drawdown (P10)   : ${p10.toFixed(2)}R  ← best 10% of scenarios`);
  console.log(`  Max drawdown (P50)   : ${p50.toFixed(2)}R  ← median scenario`);
  console.log(`  Max drawdown (P90)   : ${p90.toFixed(2)}R  ← worst 10% of scenarios`);
}

console.log("\n═══════════════════════════════════════════════════════════════\n");
