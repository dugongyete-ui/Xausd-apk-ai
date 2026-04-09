import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  ReactNode,
} from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform, AppState } from "react-native";
import * as BackgroundFetch from "expo-background-fetch";
import * as TaskManager from "expo-task-manager";
import {
  requestNotificationPermission,
  getExpoPushToken,
  sendSignalNotification,
  sendTPAlert,
  sendSLAlert,
} from "@/services/NotificationService";
import { playSignalSound, unlockAudioContext } from "@/services/SoundService";

const BACKGROUND_FETCH_TASK = "libartin-bg-fetch";

// ─── WIB Timezone Helper (UTC+7) ──────────────────────────────────────────────
function toWIBString(date: Date): string {
  const WIB_OFFSET = 7 * 60 * 60 * 1000;
  const wib = new Date(date.getTime() + WIB_OFFSET);
  const pad = (n: number) => String(n).padStart(2, "0");
  const days = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"];
  const months = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
  return `${days[wib.getUTCDay()]}, ${wib.getUTCDate()} ${months[wib.getUTCMonth()]} ${wib.getUTCFullYear()} ${pad(wib.getUTCHours())}:${pad(wib.getUTCMinutes())}:${pad(wib.getUTCSeconds())} WIB`;
}

if (Platform.OS !== "web") {
  TaskManager.defineTask(BACKGROUND_FETCH_TASK, async () => {
    return BackgroundFetch.BackgroundFetchResult.NewData;
  });
}

// Backend URL — server yang jalan 24/7 untuk kirim push ke device
// Priority: EXPO_PUBLIC_BACKEND_URL (production APK) > window.origin (web) > EXPO_PUBLIC_DOMAIN (dev)
const BACKEND_URL = (() => {
  const explicit = process.env.EXPO_PUBLIC_BACKEND_URL;
  if (explicit) {
    if (explicit.startsWith("http")) return explicit;
    return `https://${explicit}`;
  }
  if (typeof window !== "undefined" && window.location?.origin) {
    return window.location.origin;
  }
  if (typeof process !== "undefined" && process.env.EXPO_PUBLIC_DOMAIN) {
    const domain = process.env.EXPO_PUBLIC_DOMAIN;
    if (domain.startsWith("http")) return domain;
    const cleanDomain = domain.replace(/:5000$/, "");
    return `https://${cleanDomain}`;
  }
  return "";
})();

async function registerPushTokenWithBackend(token: string): Promise<void> {
  if (!BACKEND_URL) return;
  try {
    await fetch(`${BACKEND_URL}/api/register-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
  } catch (e) {
    console.warn("[TradingContext] Failed to register push token:", e);
  }
}

async function unregisterPushTokenFromBackend(token: string): Promise<void> {
  if (!BACKEND_URL) return;
  try {
    await fetch(`${BACKEND_URL}/api/unregister-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
  } catch (e) {
    console.warn("[TradingContext] Failed to unregister push token:", e);
  }
}

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

export type ConfirmationType = "rejection" | "engulfing";

export interface TradingSignal {
  id: string;
  pair: string;
  timeframe: string;
  trend: "Bullish" | "Bearish";
  fibTrend?: "Bullish" | "Bearish";
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
  confirmationType: ConfirmationType;
  outcome?: "win" | "loss" | "pending";
}

export type TrendState = "Bullish" | "Bearish" | "No Trade" | "Loading";
export type MarketState = "open" | "closed";

interface TradingContextValue {
  // M5 candles — shown in chart for precision entry view
  candles: Candle[];
  // M15 candles — used for structure (EMA, swing, Fibonacci)
  m15Candles: Candle[];
  currentPrice: number | null;
  ema50: number | null;
  trend: TrendState;
  fibLevels: FibLevels | null;
  bullFibLevels: FibLevels | null;
  bearFibLevels: FibLevels | null;
  fibTrend: "Bullish" | "Bearish" | null;
  currentSignal: TradingSignal | null;
  // activeSignal: sinyal aktif yang sedang di-track TP/SL
  // Berbeda dari currentSignal — tetap ada sampai TP/SL tercapai
  activeSignal: TradingSignal | null;
  signalHistory: TradingSignal[];
  atr: number | null;
  connectionStatus: "connecting" | "connected" | "disconnected";
  balance: number;
  setBalance: (b: number) => void;
  inZone: boolean;
  clearHistory: () => void;
  marketState: MarketState;
  marketNextOpen: string;
  notificationEnabled: boolean;
  requestNotifications: () => void;
  updateSignalOutcome: (id: string, outcome: "win" | "loss", signalData?: TradingSignal) => void;
  injectDemoSignal: (type: "BUY" | "SELL") => void;
  clearDemoSignal: () => void;
}

const TradingContext = createContext<TradingContextValue | null>(null);

const DERIV_WS_URL = "wss://ws.derivws.com/websockets/v3?app_id=114791";
const SYMBOL = "frxXAUUSD";

// M15 — structure: EMA50/200, swing detection, Fibonacci zones
const M15_GRAN = 900;
const M15_COUNT = 300;

// M5 — precision entry: rejection/engulfing confirmation
const M5_GRAN = 300;
const M5_COUNT = 100;

const ATR_PERIOD = 14;
const M5_ATR_MIN = 0.3;
const EMA20_PERIOD = 20;
const EMA50_PERIOD = 50;
const STORAGE_KEY_SIGNALS = "fibo_signals_v2";
const STORAGE_KEY_BALANCE = "fibo_balance_v1";
const STORAGE_KEY_M15 = "fibo_m15_candles_v2";
const STORAGE_KEY_M5 = "fibo_m5_candles_v2";

// ─── Market hours ───────────────────────────────────────────────────────────
function forexMarketOpen(): boolean {
  const now = new Date();
  const day = now.getUTCDay();
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (day === 6) return false;
  if (day === 0) return mins >= 22 * 60;
  if (day === 5) return mins < 22 * 60;
  return true;
}

function nextOpenDesc(): string {
  const now = new Date();
  const day = now.getUTCDay();
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (day === 6) {
    const minsLeft = 22 * 60 + (7 - 6) * 24 * 60 - mins;
    return `Buka Minggu ~${Math.floor(minsLeft / 60)}j ${minsLeft % 60}m lagi`;
  }
  if (day === 0 && mins < 22 * 60) {
    const minsLeft = 22 * 60 - mins;
    return `Buka hari ini ${Math.floor(minsLeft / 60)}j ${minsLeft % 60}m lagi (~22:00 UTC)`;
  }
  if (day === 5 && mins >= 22 * 60) return "Buka Minggu ~22:00 UTC";
  return "";
}

// ─── EMA helpers ─────────────────────────────────────────────────────────────
export function calcEMA(closes: number[], period: number): number[] {
  if (closes.length < period) return [];
  const k = 2 / (period + 1);
  const result: number[] = [];
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(ema);
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
function findSwings(candles: Candle[]): { bullish: SwingResult | null; bearish: SwingResult | null } {
  const LOOKBACK = Math.min(candles.length, 120);
  const slice = candles.slice(-LOOKBACK);
  const n = slice.length;
  if (n < 12) return { bullish: null, bearish: null };

  const swingHighs: number[] = [];
  const swingLows: number[] = [];
  for (let i = 1; i < n - 1; i++) {
    if (slice[i].high > slice[i - 1].high && slice[i].high > slice[i + 1].high) swingHighs.push(i);
    if (slice[i].low < slice[i - 1].low && slice[i].low < slice[i + 1].low)   swingLows.push(i);
  }

  function isCleanImpulse(
    fromIdx: number, toIdx: number,
    fromPrice: number, toPrice: number,
    dir: "up" | "down"
  ): boolean {
    const span = toIdx - fromIdx;
    if (span < 3 || span > 25) return false;
    const range = Math.abs(toPrice - fromPrice);
    if (range < 5) return false;
    for (let j = fromIdx; j <= toIdx; j++) {
      if (dir === "up"   && slice[j].low  < fromPrice - range * 0.30) return false;
      if (dir === "down" && slice[j].high > fromPrice + range * 0.30) return false;
    }
    const mid = fromIdx + Math.floor(span / 2);
    let sumA = 0, cntA = 0, sumB = 0, cntB = 0;
    for (let j = fromIdx; j <= toIdx; j++) {
      if (j <= mid) { sumA += slice[j].close; cntA++; }
      else          { sumB += slice[j].close; cntB++; }
    }
    if (cntA === 0 || cntB === 0) return false;
    const avgA = sumA / cntA, avgB = sumB / cntB;
    if (dir === "up"   && avgB <= avgA) return false;
    if (dir === "down" && avgB >= avgA) return false;
    return true;
  }

  // ── Cari impulse NAIK terbaru: SwingLow → SwingHigh (BUY) ────────────────
  let bullResult: SwingResult | null = null;
  for (let hi = swingHighs.length - 1; hi >= 0; hi--) {
    const hIdx = swingHighs[hi];
    const swingHighPrice = slice[hIdx].high;
    for (let li = swingLows.length - 1; li >= 0; li--) {
      const lIdx = swingLows[li];
      if (lIdx >= hIdx) continue;
      if (isCleanImpulse(lIdx, hIdx, slice[lIdx].low, swingHighPrice, "up")) {
        bullResult = { swingHigh: swingHighPrice, swingLow: slice[lIdx].low, anchorEpoch: slice[hIdx].epoch };
        break;
      }
    }
    if (bullResult) break;
  }

  // ── Cari impulse TURUN terbaru: SwingHigh → SwingLow (SELL) ──────────────
  let bearResult: SwingResult | null = null;
  for (let li = swingLows.length - 1; li >= 0; li--) {
    const lIdx = swingLows[li];
    const swingLowPrice = slice[lIdx].low;
    for (let hi = swingHighs.length - 1; hi >= 0; hi--) {
      const hIdx = swingHighs[hi];
      if (hIdx >= lIdx) continue;
      if (isCleanImpulse(hIdx, lIdx, slice[hIdx].high, swingLowPrice, "down")) {
        bearResult = { swingHigh: slice[hIdx].high, swingLow: swingLowPrice, anchorEpoch: slice[lIdx].epoch };
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

// ─── M5 Entry confirmation ───────────────────────────────────────────────────
// Rejection Pin Bar — diperlonggar:
// ① Candle arah sesuai trend (bullish close / bearish close)
// ② Wick dominan ≥ 0.8× body (dari 1.5× — lebih permisif)
// ③ Wick menyentuh/masuk zona DIPERLUAS (50%–88.6%)
// Body center check DIHAPUS — terlalu ketat
// Hanya candle CLOSED yang boleh dievaluasi (dipastikan dari caller)
function checkRejection(candle: Candle, trend: "Bullish" | "Bearish", fib: FibLevels): boolean {
  const body = Math.abs(candle.close - candle.open);
  if (body === 0) return false;

  // Zona diperluas: 50%–88.6%
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

// Checks last two M5 candles for engulfing pattern — diperlonggar untuk scalping (partial engulf 55%)
function checkEngulfing(prev: Candle, curr: Candle, trend: "Bullish" | "Bearish"): boolean {
  const prevBody = Math.abs(prev.close - prev.open);
  const currBody = Math.abs(curr.close - curr.open);
  if (prevBody === 0 || currBody === 0) return false;
  if (trend === "Bullish") {
    const prevBear = prev.close < prev.open;
    const currBull = curr.close > curr.open;
    if (!prevBear || !currBull) return false;
    const engulfTarget = prev.close + (prev.open - prev.close) * 0.55;
    return curr.close >= engulfTarget && curr.open <= prev.close + prevBody * 0.35;
  }
  const prevBull = prev.close > prev.open;
  const currBear = curr.close < curr.open;
  if (!prevBull || !currBear) return false;
  const engulfTarget = prev.close - (prev.close - prev.open) * 0.55;
  return curr.close <= engulfTarget && curr.open >= prev.close - prevBody * 0.35;
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

// ─── Provider ─────────────────────────────────────────────────────────────────
export function TradingProvider({ children }: { children: ReactNode }) {
  // M5 candles — precision entry, shown in chart
  const [m5Candles, setM5Candles] = useState<Candle[]>([]);
  // M15 candles — structure, EMA/swing/Fibonacci
  const [m15Candles, setM15Candles] = useState<Candle[]>([]);
  const [currentPrice, setCurrentPrice] = useState<number | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<"connecting" | "connected" | "disconnected">("connecting");
  const [signalHistory, setSignalHistory] = useState<TradingSignal[]>([]);
  // activeSignal: sinyal yang sedang aktif untuk tracking TP/SL
  // Tetap ada setelah currentSignal null (karena single-position rule)
  // Reset ketika TP/SL tercapai atau anchor baru terbentuk
  const [activeSignal, setActiveSignal] = useState<TradingSignal | null>(null);
  const [balance, setBalanceState] = useState<number>(10000);
  const [marketState, setMarketState] = useState<MarketState>(forexMarketOpen() ? "open" : "closed");
  const [marketNextOpen, setMarketNextOpen] = useState(nextOpenDesc());
  const [notificationEnabled, setNotificationEnabled] = useState<boolean>(false);
  const pushTokenRef = useRef<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const marketCheckTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const savedSignalKeys = useRef<Set<string>>(new Set());
  const wasOpenRef = useRef<boolean>(forexMarketOpen());
  const derivMarketClosedRef = useRef<boolean>(false);
  // Dedup: 1 sinyal per candle M5 closed — unlimited signal tanpa cooldown waktu
  const lastSignaledCandleEpochRef = useRef<number | null>(null);
  // Track kapan history terakhir di-clear — untuk filter sync dari server
  const clearedAtRef = useRef<number | null>(null);
  // Lock sinyal per candle epoch+arah — mencegah Entry/TP/SL bergerak setiap tick
  // Map dari sigKey → signal untuk mendukung deteksi bidirectional
  const lockedSignalsMapRef = useRef<Map<string, TradingSignal>>(new Map());
  // IDs sinyal yang sudah resolved (win/loss) — jangan emit ulang dari useMemo
  const resolvedSignalKeysRef = useRef<Set<string>>(new Set());
  // ─── Startup: unlock audio context on web ────────────────────────────────
  useEffect(() => {
    unlockAudioContext();
  }, []);

  // ─── Helper: cari sinyal pending terbaru dari history ──────────────────────
  // Digunakan untuk restore activeSignal saat startup / sync dari server.
  // Cek apakah TP/SL sudah tercapai berdasarkan harga terakhir yang diketahui.
  const findLatestPendingSignal = useCallback(
    (signals: TradingSignal[], price: number | null): TradingSignal | null => {
      const pending = signals.find((s) => !s.outcome || s.outcome === "pending");
      if (!pending) return null;
      if (price !== null) {
        const isBull = pending.trend === "Bullish";
        const tp1Hit = isBull ? price >= pending.takeProfit : price <= pending.takeProfit;
        const tp2Hit = pending.takeProfit2 !== undefined
          ? (isBull ? price >= pending.takeProfit2 : price <= pending.takeProfit2)
          : false;
        const slHit = isBull ? price <= pending.stopLoss : price >= pending.stopLoss;
        if (tp1Hit || tp2Hit || slHit) return null;
      }
      return pending;
    },
    []
  );

  // ─── Startup: load cached data + fetch real signals dari backend ──────────
  useEffect(() => {
    // Langkah 1: Tampilkan data cache (AsyncStorage) secepatnya
    Promise.all([
      AsyncStorage.getItem(STORAGE_KEY_SIGNALS),
      AsyncStorage.getItem(STORAGE_KEY_BALANCE),
      AsyncStorage.getItem(STORAGE_KEY_M15),
      AsyncStorage.getItem(STORAGE_KEY_M5),
    ]).then(([sigRaw, balRaw, m15Raw, m5Raw]) => {
      let cachedPrice: number | null = null;

      // Balance
      if (balRaw) setBalanceState(parseFloat(balRaw) || 10000);

      // M15 candles
      if (m15Raw) {
        try {
          const parsed: Candle[] = JSON.parse(m15Raw);
          if (parsed.length >= EMA50_PERIOD) setM15Candles(parsed);
        } catch {}
      }

      // M5 candles
      if (m5Raw) {
        try {
          const parsed: Candle[] = JSON.parse(m5Raw);
          if (parsed.length > 0) {
            setM5Candles(parsed);
            cachedPrice = parsed[parsed.length - 1].close;
            setCurrentPrice(cachedPrice);
          }
        } catch {}
      }

      // Sinyal dari cache — hanya load sinyal yang sudah resolved (win/loss)
      // Sinyal pending tidak di-restore saat startup — hilang jika belum kena TP/SL
      if (sigRaw) {
        try {
          const allCached = JSON.parse(sigRaw) as TradingSignal[];
          const cached = allCached.filter((s) => s.outcome === "win" || s.outcome === "loss");
          setSignalHistory(cached);
          cached.forEach((s) => savedSignalKeys.current.add(s.id));
          console.log(`[TradingContext] Loaded ${cached.length} resolved signals from cache (${allCached.length - cached.length} pending discarded)`);
        } catch {}
      }

      // Langkah 1.5: Restore active pending signal dari backend jika ada
      // Penting: jika user buka app di tengah trade, sinyal aktif harus tampil
      if (BACKEND_URL) {
        fetch(`${BACKEND_URL}/api/current-signal`)
          .then((r) => r.json())
          .then((data: { signal: TradingSignal | null }) => {
            if (data.signal && data.signal.outcome === "pending") {
              // Restore signal as activeSignal — TP/SL tracking will take over
              setActiveSignal((prev) => {
                if (prev) return prev; // already have one, don't overwrite
                console.log(`[TradingContext] Restored active signal from backend: ${data.signal!.id}`);
                return data.signal!;
              });
              // Also register in savedSignalKeys so dedup works
              savedSignalKeys.current.add(data.signal.id);
            }
          })
          .catch(() => {});
      }

      // Langkah 2: Fetch sinyal REAL dari backend server (berjalan 24/7)
      // Backend terus generate sinyal meskipun device offline
      fetch(`${BACKEND_URL}/api/signals`)
        .then((r) => r.json())
        .then((serverSignals: TradingSignal[]) => {
          if (!Array.isArray(serverSignals)) return;

          // Merge sinyal server dengan cache lokal — server selalu lebih otoritatif
          setSignalHistory((prev) => {
            if (serverSignals.length === 0) {
              // Server kosong — mungkin sudah di-clear, tetap kosongkan lokal juga
              savedSignalKeys.current.clear();
              AsyncStorage.setItem(STORAGE_KEY_SIGNALS, JSON.stringify([])).catch(() => {});
              return [];
            }

            const serverIds = new Set(serverSignals.map((s) => s.id));
            const newFromServer = serverSignals.filter((s) => !savedSignalKeys.current.has(s.id));

            // Gabungkan: server otoritatif untuk shared IDs,
            // tapi pertahankan sinyal lokal yang sudah resolved tapi belum di server
            const localOnlyResolved = prev.filter(
              (s) => !serverIds.has(s.id) && (s.outcome === "win" || s.outcome === "loss")
            );
            const merged = [...serverSignals, ...localOnlyResolved];
            merged.sort((a, b) =>
              new Date(b.timestampUTC).getTime() - new Date(a.timestampUTC).getTime()
            );

            // Update savedSignalKeys
            merged.forEach((s) => savedSignalKeys.current.add(s.id));

            // Cache ke AsyncStorage untuk offline berikutnya
            AsyncStorage.setItem(STORAGE_KEY_SIGNALS, JSON.stringify(merged)).catch(() => {});

            if (newFromServer.length > 0) {
              console.log(`[TradingContext] ${newFromServer.length} sinyal baru dari server (total: ${merged.length})`);
            }

            // Jika activeSignal di-client sudah resolved di server, hapus activeSignal
            setActiveSignal((prev) => {
              if (!prev) return null;
              const serverVersion = merged.find((s) => s.id === prev.id);
              if (serverVersion && (serverVersion.outcome === "win" || serverVersion.outcome === "loss")) {
                console.log(`[TradingContext] ActiveSignal cleared — server says ${serverVersion.outcome}: ${prev.id}`);
                return null;
              }
              return prev;
            });

            return merged;
          });
        })
        .catch(() => {
          // Device offline — tetap pakai cache, tidak masalah
          console.log("[TradingContext] Tidak bisa fetch dari server, pakai cache lokal");
        });
    }).catch(() => {});

    // Request notification permission + register push token dengan backend
    if (Platform.OS !== "web") {
      requestNotificationPermission().then(async (granted) => {
        setNotificationEnabled(granted);
        if (granted) {
          const token = await getExpoPushToken();
          if (token) {
            pushTokenRef.current = token;
            await registerPushTokenWithBackend(token);
            console.log("[TradingContext] Push token registered:", token.slice(0, 40) + "...");
          }
        }
      });

      // Register background fetch task untuk wakeup periodik
      BackgroundFetch.registerTaskAsync(BACKGROUND_FETCH_TASK, {
        minimumInterval: 15 * 60,
        stopOnTerminate: false,
        startOnBoot: true,
      }).catch(() => {});
    }

    // ── Periodic sync: fetch sinyal real dari server setiap 3 menit ──────────
    // Memastikan sinyal yang di-generate server saat device offline
    // akan langsung muncul setelah device kembali online.
    const fetchAndMergeSignals = () => {
      if (!BACKEND_URL) return;
      fetch(`${BACKEND_URL}/api/signals`)
        .then((r) => r.json())
        .then((serverSignals: TradingSignal[]) => {
          if (!Array.isArray(serverSignals)) return;

          // Kalau server kosong, clear lokal juga (sinkron setelah clear dari device lain)
          if (serverSignals.length === 0) {
            setSignalHistory((prev) => {
              if (prev.length === 0) return prev;
              savedSignalKeys.current.clear();
              AsyncStorage.setItem(STORAGE_KEY_SIGNALS, JSON.stringify([])).catch(() => {});
              return [];
            });
            setActiveSignal((prev) => {
              if (!prev || prev.outcome === "win" || prev.outcome === "loss") return null;
              return prev;
            });
            return;
          }

          setSignalHistory((prev) => {
            const serverIds = new Set(serverSignals.map((s) => s.id));
            const newOnes = serverSignals.filter((s) => !savedSignalKeys.current.has(s.id));
            // Pertahankan sinyal lokal yang sudah resolved tapi belum di server
            const localOnlyResolved = prev.filter(
              (s) => !serverIds.has(s.id) && (s.outcome === "win" || s.outcome === "loss")
            );
            const merged = [...serverSignals, ...localOnlyResolved].sort(
              (a, b) => new Date(b.timestampUTC).getTime() - new Date(a.timestampUTC).getTime()
            );
            merged.forEach((s) => savedSignalKeys.current.add(s.id));

            if (newOnes.length > 0) {
              AsyncStorage.setItem(STORAGE_KEY_SIGNALS, JSON.stringify(merged)).catch(() => {});
              console.log(`[TradingContext] Sync: +${newOnes.length} sinyal baru dari server`);
            }

            // Jika activeSignal sudah resolved di server, hapus dari client
            setActiveSignal((prevActive) => {
              if (!prevActive) return null;
              const serverVersion = merged.find((s) => s.id === prevActive.id);
              if (serverVersion && (serverVersion.outcome === "win" || serverVersion.outcome === "loss")) {
                console.log(`[TradingContext] Sync: activeSignal cleared — server says ${serverVersion.outcome}`);
                return null;
              }
              return prevActive;
            });

            return merged.length !== prev.length || newOnes.length > 0 ? merged : prev;
          });
        })
        .catch(() => {});
    };

    const syncTimer = setInterval(fetchAndMergeSignals, 3 * 60 * 1000);

    // ── Periodic check: restore active pending signal from backend ────────────
    const fetchCurrentSignal = () => {
      if (!BACKEND_URL) return;
      fetch(`${BACKEND_URL}/api/current-signal`)
        .then((r) => r.json())
        .then((data: { signal: TradingSignal | null }) => {
          if (data.signal && data.signal.outcome === "pending") {
            setActiveSignal((prev) => {
              // Only restore if no active signal is being tracked locally
              if (prev && prev.outcome === "pending") return prev;
              if (resolvedSignalKeysRef.current.has(data.signal!.id)) return prev;
              console.log(`[TradingContext] Periodic sync: restored pending signal ${data.signal!.id}`);
              savedSignalKeys.current.add(data.signal!.id);
              return data.signal!;
            });
          }
        })
        .catch(() => {});
    };
    const signalSyncTimer = setInterval(fetchCurrentSignal, 20 * 1000);

    return () => {
      clearInterval(syncTimer);
      clearInterval(signalSyncTimer);
    };

  }, [findLatestPendingSignal]);

  const setBalance = useCallback((b: number) => {
    setBalanceState(b);
    AsyncStorage.setItem(STORAGE_KEY_BALANCE, String(b));
  }, []);

  // Unlimited history
  const saveSignal = useCallback((sig: TradingSignal, key: string) => {
    if (savedSignalKeys.current.has(key)) return;
    savedSignalKeys.current.add(key);
    const sigWithOutcome: TradingSignal = { ...sig, outcome: "pending" };
    setSignalHistory((prev) => {
      const next = [sigWithOutcome, ...prev];
      AsyncStorage.setItem(STORAGE_KEY_SIGNALS, JSON.stringify(next));
      return next;
    });
  }, []);

  const updateSignalOutcome = useCallback((id: string, outcome: "win" | "loss", signalData?: TradingSignal) => {
    setSignalHistory((prev) => {
      const exists = prev.find((s) => s.id === id);
      let updated: TradingSignal[];
      if (exists) {
        updated = prev.map((s) =>
          s.id === id ? { ...s, outcome, status: "closed" as const } : s
        );
      } else if (signalData) {
        // Sinyal belum ada di history (masih pending) — tambahkan langsung dengan outcome resolved
        const resolved: TradingSignal = { ...signalData, outcome, status: "closed" as const };
        updated = [resolved, ...prev];
        savedSignalKeys.current.add(id);
      } else {
        return prev;
      }
      AsyncStorage.setItem(STORAGE_KEY_SIGNALS, JSON.stringify(updated));
      return updated;
    });
  }, []);

  const clearHistory = useCallback(() => {
    setSignalHistory([]);
    savedSignalKeys.current.clear();
    resolvedSignalKeysRef.current.clear();
    lockedSignalsMapRef.current.clear();
    setActiveSignal(null);
    clearedAtRef.current = Date.now();
    AsyncStorage.setItem(STORAGE_KEY_SIGNALS, JSON.stringify([])).catch(() => {});
    // Hapus juga dari server supaya tidak muncul lagi saat sync
    if (BACKEND_URL) {
      fetch(`${BACKEND_URL}/api/signals`, { method: "DELETE" }).catch(() => {});
    }
  }, []);

  const requestNotifications = useCallback(() => {
    if (Platform.OS !== "web") {
      requestNotificationPermission().then(async (granted) => {
        setNotificationEnabled(granted);
        if (granted) {
          const token = await getExpoPushToken();
          if (token) {
            pushTokenRef.current = token;
            await registerPushTokenWithBackend(token);
          }
        } else if (pushTokenRef.current) {
          await unregisterPushTokenFromBackend(pushTokenRef.current);
          pushTokenRef.current = null;
        }
      });
    }
  }, []);

  // ─── WebSocket ─────────────────────────────────────────────────────────────
  const connect = useCallback(() => {
    if (!forexMarketOpen()) return;
    if (derivMarketClosedRef.current) return;
    if (wsRef.current) { try { wsRef.current.close(); } catch {} }
    setConnectionStatus("connecting");

    const ws = new WebSocket(DERIV_WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnectionStatus("connected");

      // Subscribe M15 — structure
      ws.send(JSON.stringify({
        ticks_history: SYMBOL,
        adjust_start_time: 1,
        count: M15_COUNT,
        end: "latest",
        granularity: M15_GRAN,
        style: "candles",
        subscribe: 1,
      }));

      // Subscribe M5 — precision entry
      ws.send(JSON.stringify({
        ticks_history: SYMBOL,
        adjust_start_time: 1,
        count: M5_COUNT,
        end: "latest",
        granularity: M5_GRAN,
        style: "candles",
        subscribe: 1,
      }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.error) {
          const errMsg: string = msg.error.message ?? "";
          console.error("[WS] Error:", errMsg);

          // Deriv says market is closed — update state and stop reconnecting
          if (
            errMsg.toLowerCase().includes("market is presently closed") ||
            errMsg.toLowerCase().includes("market is closed") ||
            msg.error.code === "MarketIsClosed"
          ) {
            derivMarketClosedRef.current = true;
            setMarketState("closed");
            setMarketNextOpen("Market XAUUSD sedang tutup sementara (maintenance Deriv). Akan otomatis reconnect dalam 30 detik.");
            if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
            // Close WS cleanly — market check timer will reset flag and reconnect
            try { ws.close(); } catch {}
          }
          return;
        }

        // Initial candle history — route by granularity in echo_req
        if (msg.msg_type === "candles" && Array.isArray(msg.candles)) {
          const gran: number = msg.echo_req?.granularity ?? 0;
          const parsed = msg.candles
            .map((c: Parameters<typeof parseCandle>[0]) => parseCandle(c))
            .filter((c: Candle | null): c is Candle => c !== null);
          if (parsed.length === 0) return;

          if (gran === M15_GRAN) {
            setM15Candles(parsed);
            // Persist so next startup is instant
            AsyncStorage.setItem(STORAGE_KEY_M15, JSON.stringify(parsed)).catch(() => {});
          } else if (gran === M5_GRAN) {
            setM5Candles(parsed);
            setCurrentPrice(parsed[parsed.length - 1].close);
            AsyncStorage.setItem(STORAGE_KEY_M5, JSON.stringify(parsed)).catch(() => {});
          }
          return;
        }

        // Live tick updates — route by ohlc.granularity
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

          const updater = (
            prev: Candle[],
            maxCount: number,
            storageKey: string,
            minSaveLen: number
          ): Candle[] => {
            if (prev.length === 0) return [nc];
            const last = prev[prev.length - 1];
            if (last.epoch === nc.epoch) {
              // Same candle updating (same epoch) — no save needed
              const updated = [...prev];
              updated[updated.length - 1] = nc;
              return updated;
            }
            // New completed candle — append and persist
            const next = [...prev, nc];
            if (next.length > maxCount) next.shift();
            if (next.length >= minSaveLen) {
              AsyncStorage.setItem(storageKey, JSON.stringify(next)).catch(() => {});
            }
            return next;
          };

          if (gran === M15_GRAN) {
            setM15Candles((prev) =>
              updater(prev, M15_COUNT, STORAGE_KEY_M15, EMA50_PERIOD)
            );
          } else if (gran === M5_GRAN) {
            setCurrentPrice(nc.close);
            setM5Candles((prev) =>
              updater(prev, M5_COUNT, STORAGE_KEY_M5, 1)
            );
          }
        }
      } catch (e) {
        console.error("[WS] Parse error:", e);
      }
    };

    ws.onerror = () => setConnectionStatus("disconnected");

    ws.onclose = () => {
      setConnectionStatus("disconnected");
      wsRef.current = null;
      // Don't reconnect if Deriv itself said market is closed — wait for market check timer
      if (forexMarketOpen() && !derivMarketClosedRef.current) {
        reconnectTimer.current = setTimeout(() => {
          reconnectTimer.current = null;
          connect();
        }, 3000);
      }
    };
  }, []);

  // ─── Market hours polling ──────────────────────────────────────────────────
  useEffect(() => {
    connect();

    marketCheckTimer.current = setInterval(() => {
      const isOpen = forexMarketOpen();

      const wasOpen = wasOpenRef.current;
      wasOpenRef.current = isOpen;

      if (isOpen && !wasOpen) {
        // Market just opened — keep cached candles visible while WS reconnects
        derivMarketClosedRef.current = false;
        setMarketState("open");
        setMarketNextOpen("");
        setCurrentPrice(null);
        if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
        connect();
      } else if (!isOpen && wasOpen) {
        // Market just closed — disconnect WS, keep last candles visible
        setMarketState("closed");
        setMarketNextOpen(nextOpenDesc());
        if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
        if (wsRef.current) { try { wsRef.current.close(); } catch {} wsRef.current = null; }
        setCurrentPrice(null);
      } else if (isOpen) {
        // Market should be open — if WS is disconnected (e.g. Deriv maintenance ended), try reconnect
        const wsState = wsRef.current?.readyState;
        const wsDisconnected = wsState === undefined || wsState === WebSocket.CLOSED || wsState === WebSocket.CLOSING;
        if (wsDisconnected && !reconnectTimer.current) {
          // Reset Deriv-closed flag so connect() is allowed to proceed
          derivMarketClosedRef.current = false;
          setMarketState("open");
          setMarketNextOpen("");
          connect();
        }
      }
    }, 30_000);

    // Reconnect WebSocket ketika app kembali ke foreground (dari background)
    const appStateSub = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        const wsState = wsRef.current?.readyState;
        const disconnected = wsState === undefined || wsState === WebSocket.CLOSED || wsState === WebSocket.CLOSING;
        if (disconnected && forexMarketOpen() && !derivMarketClosedRef.current) {
          connect();
        }
        if (pushTokenRef.current) {
          registerPushTokenWithBackend(pushTokenRef.current).catch(() => {});
        }
      }
    });

    return () => {
      appStateSub.remove();
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (marketCheckTimer.current) clearInterval(marketCheckTimer.current);
      if (wsRef.current) wsRef.current.close();
    };
  }, [connect]);

  // ─── Indicators from M15 ──────────────────────────────────────────────────
  const ema50 = useMemo(() => {
    if (m15Candles.length < EMA50_PERIOD) return null;
    const arr = calcEMA(m15Candles.map((c) => c.close), EMA50_PERIOD);
    return arr.length > 0 ? arr[arr.length - 1] : null;
  }, [m15Candles]);

  // Trend from M15 — EMA50 only (scalping tidak butuh EMA200)
  const trend = useMemo((): TrendState => {
    if (m15Candles.length < EMA50_PERIOD) return "Loading";
    if (ema50 === null) return "Loading";
    const last = m15Candles[m15Candles.length - 1].close;
    if (last > ema50) return "Bullish";
    if (last < ema50) return "Bearish";
    return "No Trade";
  }, [m15Candles, ema50]);

  // ATR from M15
  const atr = useMemo(() => {
    if (m15Candles.length < ATR_PERIOD + 1) return null;
    return calcATR(m15Candles, ATR_PERIOD);
  }, [m15Candles]);

  // ─── FIBONACCI DUAL-DIRECTION ─────────────────────────────────────────────
  // Dua set Fibonacci terpisah: BUY (impulse naik) dan SELL (impulse turun).
  // Masing-masing update mandiri ketika struktur swing berubah.
  const [bullFibLevels, setBullFibLevels] = useState<FibLevels | null>(null);
  const [bearFibLevels, setBearFibLevels] = useState<FibLevels | null>(null);
  const [fibTrend, setFibTrend] = useState<"Bullish" | "Bearish" | null>(null);
  const [currentAnchorEpoch, setCurrentAnchorEpoch] = useState<number | null>(null);
  const lastBullSwingRef = useRef<{ anchorEpoch: number; pairValue: number } | null>(null);
  const lastBearSwingRef = useRef<{ anchorEpoch: number; pairValue: number } | null>(null);

  useEffect(() => {
    if (m15Candles.length < EMA50_PERIOD) {
      lastBullSwingRef.current = null;
      lastBearSwingRef.current = null;
      setBullFibLevels(null);
      setBearFibLevels(null);
      return;
    }

    const swings = findSwings(m15Candles);

    // ── Update Fibonacci BUY ───────────────────────────────────────────────
    if (swings.bullish) {
      const { swingHigh, swingLow, anchorEpoch } = swings.bullish;
      const pairValue = swingHigh;
      const last = lastBullSwingRef.current;
      const anchorChanged = !last || last.anchorEpoch !== anchorEpoch;
      const pairChanged = last && last.anchorEpoch === anchorEpoch && last.pairValue !== pairValue;
      if (anchorChanged || pairChanged) {
        lastBullSwingRef.current = { anchorEpoch, pairValue };
        setBullFibLevels(calcFib(swingHigh, swingLow, "Bullish"));
        if (anchorChanged && (!swings.bearish || anchorEpoch >= (swings.bearish?.anchorEpoch ?? 0))) {
          setCurrentAnchorEpoch(anchorEpoch);
          setFibTrend("Bullish");
        }
      }
    } else {
      lastBullSwingRef.current = null;
      setBullFibLevels(null);
    }

    // ── Update Fibonacci SELL ──────────────────────────────────────────────
    if (swings.bearish) {
      const { swingHigh, swingLow, anchorEpoch } = swings.bearish;
      const pairValue = swingLow;
      const last = lastBearSwingRef.current;
      const anchorChanged = !last || last.anchorEpoch !== anchorEpoch;
      const pairChanged = last && last.anchorEpoch === anchorEpoch && last.pairValue !== pairValue;
      if (anchorChanged || pairChanged) {
        lastBearSwingRef.current = { anchorEpoch, pairValue };
        setBearFibLevels(calcFib(swingHigh, swingLow, "Bearish"));
        if (anchorChanged && (!swings.bullish || anchorEpoch >= (swings.bullish?.anchorEpoch ?? 0))) {
          setCurrentAnchorEpoch(anchorEpoch);
          setFibTrend("Bearish");
        }
      }
    } else {
      lastBearSwingRef.current = null;
      setBearFibLevels(null);
    }
  }, [m15Candles]);

  // fibLevels: arah yang paling aktif (untuk display chart)
  const fibLevels = useMemo((): FibLevels | null => {
    if (bullFibLevels && bearFibLevels) {
      const bullAnchor = lastBullSwingRef.current?.anchorEpoch ?? 0;
      const bearAnchor = lastBearSwingRef.current?.anchorEpoch ?? 0;
      return bearAnchor >= bullAnchor ? bearFibLevels : bullFibLevels;
    }
    return bullFibLevels ?? bearFibLevels;
  }, [bullFibLevels, bearFibLevels]);

  // Is current M5 price inside either Fibonacci zone?
  const inZone = useMemo(() => {
    if (currentPrice === null) return false;
    const checkBull = (fib: FibLevels | null) => {
      if (!fib) return false;
      const range = Math.abs(fib.swingHigh - fib.swingLow);
      const lo = fib.swingHigh - range * 0.886;
      const hi = fib.swingHigh - range * 0.50;
      return currentPrice >= lo && currentPrice <= hi;
    };
    const checkBear = (fib: FibLevels | null) => {
      if (!fib) return false;
      const range = Math.abs(fib.swingHigh - fib.swingLow);
      const lo = fib.swingLow + range * 0.50;
      const hi = fib.swingLow + range * 0.886;
      return currentPrice >= lo && currentPrice <= hi;
    };
    return checkBull(bullFibLevels) || checkBear(bearFibLevels);
  }, [bullFibLevels, bearFibLevels, currentPrice]);

  // ─── Signal detection: BIDIRECTIONAL M15 zone + M5 confirmation ─────────
  // Cek KEDUA arah secara independen: bullFibLevels (BUY) & bearFibLevels (SELL)
  // ① Evaluasi candle M5 CLOSED (m5Candles[n-2])
  // ② Zone check per arah, tidak bergerak dengan live price
  // ③ Entry/TP/SL dari closedM5.close — terkunci per candle epoch + arah
  // ④ Return sinyal dari arah yang paling baru (anchorEpoch terbesar)
  const currentSignal = useMemo((): TradingSignal | null => {
    if (
      !atr || atr <= 0 ||
      m5Candles.length < 3 ||
      marketState === "closed" ||
      (!bullFibLevels && !bearFibLevels)
    ) return null;

    const closedM5 = m5Candles[m5Candles.length - 2];
    const prevM5   = m5Candles[m5Candles.length - 3];
    const atrVal   = atr!;

    const m5ATR = calcATR(m5Candles.slice(0, -1), ATR_PERIOD);
    if (m5ATR < M5_ATR_MIN) return null;

    // Bersihkan lock lama (epoch berbeda) agar Map tidak tumbuh selamanya
    if (lockedSignalsMapRef.current.size > 10) {
      for (const [key] of lockedSignalsMapRef.current) {
        const epoch = parseInt(key.split("_")[0], 10);
        if (epoch !== closedM5.epoch) lockedSignalsMapRef.current.delete(key);
      }
    }

    function tryDetect(fibLev: FibLevels, dir: "Bullish" | "Bearish"): TradingSignal | null {
      const sigKey = `${closedM5.epoch}_${dir}`;

      if (resolvedSignalKeysRef.current.has(sigKey)) return null;

      const locked = lockedSignalsMapRef.current.get(sigKey);
      if (locked) return locked;

      const range = Math.abs(fibLev.swingHigh - fibLev.swingLow);
      let lo: number, hi: number;
      if (dir === "Bearish") {
        lo = fibLev.swingLow + range * 0.50;
        hi = fibLev.swingLow + range * 0.886;
      } else {
        lo = fibLev.swingHigh - range * 0.886;
        hi = fibLev.swingHigh - range * 0.50;
      }

      const candleTouchesZone = dir === "Bearish"
        ? closedM5.high >= lo || (currentPrice !== null && currentPrice >= lo && currentPrice <= hi)
        : closedM5.low <= hi  || (currentPrice !== null && currentPrice >= lo && currentPrice <= hi);
      if (!candleTouchesZone) return null;

      const isRejection = checkRejection(closedM5, dir, fibLev);
      const isEngulfing = checkEngulfing(prevM5, closedM5, dir);
      if (!isRejection && !isEngulfing) return null;

      const confirmationType: ConfirmationType = isEngulfing ? "engulfing" : "rejection";
      const sl = dir === "Bullish" ? fibLev.swingLow : fibLev.swingHigh;
      const entryPrice = closedM5.close;
      const slDistance = Math.abs(entryPrice - sl);
      if (slDistance < atrVal * 0.1 || atrVal < 0.1) return null;

      const tp1Dist = Math.min(slDistance * 1.0, 15);
      const tp1 = dir === "Bearish" ? entryPrice - tp1Dist : entryPrice + tp1Dist;

      const tp2Dist = Math.min(Math.max(slDistance * 1.8, 10), 28);
      const tp2 = dir === "Bearish" ? entryPrice - tp2Dist : entryPrice + tp2Dist;

      const riskAmount = balance * 0.01;
      const lotSize = riskAmount / slDistance;
      const rr1 = tp1Dist / slDistance;
      const rr2 = tp2Dist / slDistance;

      const signal: TradingSignal = {
        id: sigKey,
        pair: "XAUUSD",
        timeframe: "M15/M5",
        trend: dir,
        fibTrend: dir,
        entryPrice,
        stopLoss: sl,
        takeProfit: tp1,
        takeProfit2: tp2,
        riskReward: Math.round(rr1 * 100) / 100,
        riskReward2: Math.round(rr2 * 100) / 100,
        lotSize: Math.round(lotSize * 100) / 100,
        timestampUTC: toWIBString(new Date(Date.now())),
        fibLevels: fibLev,
        status: "active",
        signalCandleEpoch: closedM5.epoch,
        confirmationType,
        outcome: "pending",
      };

      lockedSignalsMapRef.current.set(sigKey, signal);
      return signal;
    }

    const bullSig = bullFibLevels ? tryDetect(bullFibLevels, "Bullish") : null;
    const bearSig = bearFibLevels ? tryDetect(bearFibLevels, "Bearish") : null;

    if (bullSig && bearSig) {
      const bullAnchor = lastBullSwingRef.current?.anchorEpoch ?? 0;
      const bearAnchor = lastBearSwingRef.current?.anchorEpoch ?? 0;
      return bearAnchor >= bullAnchor ? bearSig : bullSig;
    }
    return bullSig ?? bearSig;
  }, [bullFibLevels, bearFibLevels, atr, m5Candles, balance, marketState, currentPrice]);

  useEffect(() => {
    if (currentSignal) {
      lastSignaledCandleEpochRef.current = currentSignal.signalCandleEpoch ?? null;
      // Set as activeSignal untuk TP/SL tracking di dashboard
      // JANGAN simpan ke signalHistory — hanya masuk history setelah TP/SL resolved
      setActiveSignal(currentSignal);
    }
  }, [currentSignal?.id]);

  // Ketika anchor baru terbentuk, hanya clear activeSignal jika sudah resolved
  // (outcome win/loss). Jika masih pending, biarkan TP/SL tracker yang handle.
  // Jangan hapus sinyal pending — bisa menyebabkan dashboard kosong padahal ada sinyal aktif.
  useEffect(() => {
    setActiveSignal((prev) => {
      if (!prev) return null;
      if (prev.outcome === "win" || prev.outcome === "loss") return null;
      return prev;
    });
  }, [currentAnchorEpoch]);

  // ─── Notify when a NEW signal appears ─────────────────────────────────────
  const prevSignalIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!currentSignal) return;
    if (currentSignal.id === prevSignalIdRef.current) return;
    prevSignalIdRef.current = currentSignal.id;
    playSignalSound("signal").catch(() => {});
    if (notificationEnabled && Platform.OS !== "web") {
      sendSignalNotification({
        trend: currentSignal.trend,
        entryPrice: currentSignal.entryPrice,
        stopLoss: currentSignal.stopLoss,
        takeProfit: currentSignal.takeProfit,
        riskReward: currentSignal.riskReward,
        lotSize: currentSignal.lotSize,
        confirmationType: currentSignal.confirmationType,
      }).catch(() => {});
    }
  }, [currentSignal?.id, notificationEnabled]);

  // ─── Track TP/SL hit for active signal ────────────────────────────────────
  // Pakai activeSignal (bukan currentSignal) supaya tracking tetap berjalan
  // meskipun currentSignal sudah null (karena single-position rule)
  const tpSlNotifiedRef = useRef<{ id: string; tp: boolean; sl: boolean }>({
    id: "",
    tp: false,
    sl: false,
  });
  useEffect(() => {
    if (!activeSignal || currentPrice === null) return;
    const tracked = tpSlNotifiedRef.current;
    if (tracked.id !== activeSignal.id) {
      tpSlNotifiedRef.current = { id: activeSignal.id, tp: false, sl: false };
    }

    const isBull = activeSignal.trend === "Bullish";

    // Check TP1 atau TP2 hit
    if (!tpSlNotifiedRef.current.tp) {
      const tp1Hit = isBull
        ? currentPrice >= activeSignal.takeProfit
        : currentPrice <= activeSignal.takeProfit;
      const tp2Hit = activeSignal.takeProfit2 !== undefined
        ? (isBull ? currentPrice >= activeSignal.takeProfit2 : currentPrice <= activeSignal.takeProfit2)
        : false;
      if (tp1Hit || tp2Hit) {
        const hitLevel = tp2Hit ? activeSignal.takeProfit2! : activeSignal.takeProfit;
        tpSlNotifiedRef.current.tp = true;
        tpSlNotifiedRef.current.sl = true;
        resolvedSignalKeysRef.current.add(activeSignal.id);
        lockedSignalsMapRef.current.delete(activeSignal.id);
        updateSignalOutcome(activeSignal.id, "win", activeSignal);
        setActiveSignal(null);
        playSignalSound("tp").catch(() => {});
        if (BACKEND_URL) {
          fetch(`${BACKEND_URL}/api/ai/outcome`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ signalId: activeSignal.id, outcome: "win" }),
          }).catch(() => {});
        }
        if (notificationEnabled && Platform.OS !== "web") {
          sendTPAlert({
            trend: activeSignal.trend,
            entryPrice: activeSignal.entryPrice,
            takeProfit: hitLevel,
            currentPrice,
          }).catch(() => {});
        }
      }
    }

    // Check SL hit
    if (!tpSlNotifiedRef.current.sl) {
      const slHit = isBull
        ? currentPrice <= activeSignal.stopLoss
        : currentPrice >= activeSignal.stopLoss;
      if (slHit) {
        tpSlNotifiedRef.current.sl = true;
        tpSlNotifiedRef.current.tp = true;
        resolvedSignalKeysRef.current.add(activeSignal.id);
        lockedSignalsMapRef.current.delete(activeSignal.id);
        updateSignalOutcome(activeSignal.id, "loss", activeSignal);
        setActiveSignal(null);
        playSignalSound("sl").catch(() => {});
        if (BACKEND_URL) {
          fetch(`${BACKEND_URL}/api/ai/outcome`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ signalId: activeSignal.id, outcome: "loss" }),
          }).catch(() => {});
        }
        if (notificationEnabled && Platform.OS !== "web") {
          sendSLAlert({
            trend: activeSignal.trend,
            entryPrice: activeSignal.entryPrice,
            stopLoss: activeSignal.stopLoss,
            currentPrice,
          }).catch(() => {});
        }
      }
    }
  }, [currentPrice, activeSignal, notificationEnabled, updateSignalOutcome]);

  // ─── Demo / Test Signal ────────────────────────────────────────────────────
  const injectDemoSignal = React.useCallback((type: "BUY" | "SELL") => {
    const price = currentPrice ?? 5180;
    const range = 20;
    const isBuy = type === "BUY";
    const swingLow  = isBuy ? price - range : price - range * 0.4;
    const swingHigh = isBuy ? price + range * 0.4 : price + range;
    const sl = isBuy ? swingLow - 2 : swingHigh + 2;
    const tp = isBuy ? price + range * 1.5 : price - range * 1.5;
    const rr = parseFloat((Math.abs(tp - price) / Math.abs(sl - price)).toFixed(2));
    const mockFib: FibLevels = {
      swingHigh,
      swingLow,
      level618: isBuy ? swingLow + (swingHigh - swingLow) * 0.382 : swingLow + (swingHigh - swingLow) * 0.618,
      level786: isBuy ? swingLow + (swingHigh - swingLow) * 0.214 : swingLow + (swingHigh - swingLow) * 0.786,
      extensionNeg27: tp,
    };
    const slDist = Math.abs(price - sl);
    const tp1Demo = isBuy ? price + Math.min(slDist * 1.0, 15) : price - Math.min(slDist * 1.0, 15);
    const tp2Demo = tp;
    const rr1Demo = parseFloat((Math.abs(tp1Demo - price) / slDist).toFixed(2));
    const rr2Demo = parseFloat((Math.abs(tp2Demo - price) / slDist).toFixed(2));
    const demoId = `demo-${Date.now()}`;
    const demo: TradingSignal = {
      id: demoId,
      pair: "XAUUSD",
      timeframe: "M5",
      trend: isBuy ? "Bullish" : "Bearish",
      entryPrice: price,
      stopLoss: sl,
      takeProfit: tp1Demo,
      takeProfit2: tp2Demo,
      riskReward: rr1Demo,
      riskReward2: rr2Demo,
      lotSize: 0.01,
      timestampUTC: toWIBString(new Date()),
      fibLevels: mockFib,
      status: "active",
      signalCandleEpoch: m5Candles.length > 0 ? m5Candles[m5Candles.length - 1].epoch : Math.floor(Date.now() / 1000),
      confirmationType: "rejection",
      outcome: "pending",
    };
    setActiveSignal(demo);
    saveSignal(demo, demoId);
  }, [currentPrice, saveSignal, m5Candles]);

  const clearDemoSignal = React.useCallback(() => {
    setActiveSignal(null);
  }, []);

  const value = useMemo(
    () => ({
      candles: m5Candles,
      m15Candles,
      currentPrice,
      ema50,
      trend,
      fibLevels,
      bullFibLevels,
      bearFibLevels,
      fibTrend,
      currentSignal,
      activeSignal,
      signalHistory,
      atr,
      connectionStatus,
      balance,
      setBalance,
      inZone,
      clearHistory,
      marketState,
      marketNextOpen,
      notificationEnabled,
      requestNotifications,
      updateSignalOutcome,
      injectDemoSignal,
      clearDemoSignal,
    }),
    [
      m5Candles, m15Candles, currentPrice, ema50, trend,
      fibLevels, bullFibLevels, bearFibLevels, fibTrend, currentSignal, activeSignal, signalHistory, atr, connectionStatus,
      balance, setBalance, inZone, clearHistory, marketState, marketNextOpen,
      notificationEnabled, requestNotifications, updateSignalOutcome,
      injectDemoSignal, clearDemoSignal,
    ]
  );

  return (
    <TradingContext.Provider value={value}>{children}</TradingContext.Provider>
  );
}

export function useTrading() {
  const ctx = useContext(TradingContext);
  if (!ctx) throw new Error("useTrading must be used within TradingProvider");
  return ctx;
}
