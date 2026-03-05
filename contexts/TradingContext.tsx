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

const BACKGROUND_FETCH_TASK = "libartin-bg-fetch";

if (Platform.OS !== "web") {
  TaskManager.defineTask(BACKGROUND_FETCH_TASK, async () => {
    return BackgroundFetch.BackgroundFetchResult.NewData;
  });
}

// Backend URL — server yang jalan 24/7 untuk kirim push ke device
// Strip ":5000" karena Replit proxy HTTPS bekerja di port 443
const BACKEND_URL = (() => {
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
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  riskReward: number;
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
  ema200: number | null;
  trend: TrendState;
  fibLevels: FibLevels | null;
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
  updateSignalOutcome: (id: string, outcome: "win" | "loss") => void;
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
const EMA200_PERIOD = 200;
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

// Checks last two M5 candles for engulfing pattern — diperlonggar (partial engulf 75%)
function checkEngulfing(prev: Candle, curr: Candle, trend: "Bullish" | "Bearish"): boolean {
  const prevBody = Math.abs(prev.close - prev.open);
  const currBody = Math.abs(curr.close - curr.open);
  if (prevBody === 0 || currBody === 0) return false;
  if (trend === "Bullish") {
    const prevBear = prev.close < prev.open;
    const currBull = curr.close > curr.open;
    if (!prevBear || !currBull) return false;
    const engulfTarget = prev.close + (prev.open - prev.close) * 0.75;
    return curr.close >= engulfTarget && curr.open <= prev.close + prevBody * 0.25;
  }
  const prevBull = prev.close > prev.open;
  const currBear = curr.close < curr.open;
  if (!prevBull || !currBear) return false;
  const engulfTarget = prev.close - (prev.close - prev.open) * 0.75;
  return curr.close <= engulfTarget && curr.open >= prev.close - prevBody * 0.25;
}

function makeSignalKey(price: number, trend: string, epochMs: number): string {
  const bucket = Math.floor(epochMs / (5 * 60 * 1000));
  const zone = Math.round(price * 2) / 2;
  return `${zone}_${trend}_${bucket}`;
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
  // Single position rule: cooldown 30 menit per anchor (bukan permanent block)
  const lastSignaledAnchorRef = useRef<number | null>(null);
  const lastSignaledTimeMsRef = useRef<number>(0);
  // Track last swing: anchorEpoch (fractal candle epoch) + pairValue (swingLow/swingHigh).
  // Fibonacci updates when EITHER anchor changes (new fractal) OR pairValue changes
  // (market made new extreme → zone shifts responsively).
  const lastSwingRef = useRef<{ anchorEpoch: number; trend: string; pairValue: number } | null>(null);

  // ─── Startup: load all cached data instantly ──────────────────────────────
  useEffect(() => {
    // Signal history
    AsyncStorage.getItem(STORAGE_KEY_SIGNALS).then((v) => {
      if (v) {
        try {
          const parsed: TradingSignal[] = JSON.parse(v);
          setSignalHistory(parsed);
          parsed.forEach((s) => {
            savedSignalKeys.current.add(
              makeSignalKey(s.entryPrice, s.trend, new Date(s.timestampUTC).getTime())
            );
          });
        } catch {}
      }
    });

    // Balance
    AsyncStorage.getItem(STORAGE_KEY_BALANCE).then((v) => {
      if (v) setBalanceState(parseFloat(v) || 10000);
    });

    // M15 candles — load from cache so EMA/Fibonacci is ready before WS connects
    AsyncStorage.getItem(STORAGE_KEY_M15).then((v) => {
      if (v) {
        try {
          const cached: Candle[] = JSON.parse(v);
          if (cached.length >= EMA200_PERIOD) {
            setM15Candles(cached);
          }
        } catch {}
      }
    });

    // M5 candles — load from cache for chart
    AsyncStorage.getItem(STORAGE_KEY_M5).then((v) => {
      if (v) {
        try {
          const cached: Candle[] = JSON.parse(v);
          if (cached.length > 0) {
            setM5Candles(cached);
            setCurrentPrice(cached[cached.length - 1].close);
          }
        } catch {}
      }
    });

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

  }, []);

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

  const updateSignalOutcome = useCallback((id: string, outcome: "win" | "loss") => {
    setSignalHistory((prev) => {
      const updated = prev.map((s) =>
        s.id === id ? { ...s, outcome, status: "closed" as const } : s
      );
      AsyncStorage.setItem(STORAGE_KEY_SIGNALS, JSON.stringify(updated));
      return updated;
    });
  }, []);

  const clearHistory = useCallback(() => {
    setSignalHistory([]);
    savedSignalKeys.current.clear();
    AsyncStorage.setItem(STORAGE_KEY_SIGNALS, JSON.stringify([]));
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
              updater(prev, M15_COUNT, STORAGE_KEY_M15, EMA200_PERIOD)
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

  const ema200 = useMemo(() => {
    if (m15Candles.length < EMA200_PERIOD) return null;
    const arr = calcEMA(m15Candles.map((c) => c.close), EMA200_PERIOD);
    return arr.length > 0 ? arr[arr.length - 1] : null;
  }, [m15Candles]);

  // Trend from M15
  const trend = useMemo((): TrendState => {
    if (m15Candles.length < EMA200_PERIOD) return "Loading";
    if (ema50 === null || ema200 === null) return "Loading";
    const last = m15Candles[m15Candles.length - 1].close;
    if (last > ema200 && ema50 > ema200) return "Bullish";
    if (last < ema200 && ema50 < ema200) return "Bearish";
    return "No Trade";
  }, [m15Candles, ema50, ema200]);

  // ATR from M15
  const atr = useMemo(() => {
    if (m15Candles.length < ATR_PERIOD + 1) return null;
    return calcATR(m15Candles, ATR_PERIOD);
  }, [m15Candles]);

  // ─── FIBONACCI STABILITY RULE ─────────────────────────────────────────────
  // Fibonacci zones are STATIC — they only update when a NEW swing forms on M15.
  // This prevents the zones from jumping around on every candle tick.
  const [fibLevels, setFibLevels] = useState<FibLevels | null>(null);
  // currentAnchorEpoch dipakai oleh currentSignal memo untuk single position rule
  const [currentAnchorEpoch, setCurrentAnchorEpoch] = useState<number | null>(null);

  useEffect(() => {
    if (trend === "Loading" || trend === "No Trade") {
      if (lastSwingRef.current !== null) {
        lastSwingRef.current = null;
        setFibLevels(null);
        setCurrentAnchorEpoch(null);
      }
      return;
    }

    const swings = findSwings(m15Candles, trend);
    if (!swings) {
      if (lastSwingRef.current !== null) {
        lastSwingRef.current = null;
        setFibLevels(null);
        setCurrentAnchorEpoch(null);
      }
      return;
    }

    const last = lastSwingRef.current;
    const pairValue = trend === "Bearish" ? swings.swingLow : swings.swingHigh;
    const anchorChanged = !last || last.trend !== trend || last.anchorEpoch !== swings.anchorEpoch;
    const pairChanged  = last && last.anchorEpoch === swings.anchorEpoch && last.pairValue !== pairValue;

    if (anchorChanged || pairChanged) {
      lastSwingRef.current = { anchorEpoch: swings.anchorEpoch, trend, pairValue };
      // Reset signal lock hanya jika anchor benar-benar berubah (bukan sekedar pair update)
      if (anchorChanged) {
        setCurrentAnchorEpoch(swings.anchorEpoch);
      }
      setFibLevels(calcFib(swings.swingHigh, swings.swingLow, trend as "Bullish" | "Bearish"));
    }
  }, [m15Candles, trend]);

  // Is current M5 price inside M15 Fibonacci zone?
  const inZone = useMemo(() => {
    if (!fibLevels || currentPrice === null) return false;
    const lo = Math.min(fibLevels.level618, fibLevels.level786);
    const hi = Math.max(fibLevels.level618, fibLevels.level786);
    return currentPrice >= lo && currentPrice <= hi;
  }, [fibLevels, currentPrice]);

  // ─── Signal detection: M15 zone + M5 confirmation ─────────────────────────
  // Aturan entry diperlonggar untuk lebih sering menghasilkan sinyal:
  // ① Evaluasi candle M5 CLOSED (m5Candles[n-2])
  // ② Zone check diperluas: 50%–88.6% dari swing range
  // ③ Rejection: wick ≥ 0.8× body (dari 1.5×), tanpa body center check
  //    Engulfing: partial 75% engulf (dari full engulf)
  // ④ Single position: cooldown 30 menit (bukan permanent block per anchor)
  const currentSignal = useMemo((): TradingSignal | null => {
    if (
      !fibLevels || !atr || atr <= 0 ||
      trend === "Loading" || trend === "No Trade" ||
      m5Candles.length < 3 || currentPrice === null ||
      marketState === "closed" || currentAnchorEpoch === null
    ) return null;

    // ④ Single position rule: cooldown 30 menit per anchor
    const SIGNAL_COOLDOWN_MS = 30 * 60 * 1000;
    if (lastSignaledAnchorRef.current === currentAnchorEpoch &&
        Date.now() - lastSignaledTimeMsRef.current < SIGNAL_COOLDOWN_MS) return null;

    // ① Gunakan candle CLOSED: n-2 (candle closed terakhir), n-3 (sebelumnya)
    const closedM5 = m5Candles[m5Candles.length - 2];
    const prevM5   = m5Candles[m5Candles.length - 3];
    const trendDir = trend as "Bullish" | "Bearish";

    // Zona diperluas: 50%–88.6%
    const range = Math.abs(fibLevels.swingHigh - fibLevels.swingLow);
    let lo: number, hi: number;
    if (trendDir === "Bearish") {
      lo = fibLevels.swingLow + range * 0.50;
      hi = fibLevels.swingLow + range * 0.886;
    } else {
      lo = fibLevels.swingHigh - range * 0.886;
      hi = fibLevels.swingHigh - range * 0.50;
    }

    // ② Zone check diperluas + izinkan harga live di dalam zona
    const candleTouchesZone = trendDir === "Bearish"
      ? closedM5.high >= lo || (currentPrice >= lo && currentPrice <= hi)
      : closedM5.low <= hi || (currentPrice >= lo && currentPrice <= hi);
    if (!candleTouchesZone) return null;

    // Volatility filter: sangat diperlonggar
    const m5ATR = calcATR(m5Candles.slice(0, -1), ATR_PERIOD);
    if (m5ATR < M5_ATR_MIN) return null;

    // ③ M5 EMA confirmation — EMA20 > EMA50 bullish, EMA20 < EMA50 bearish
    // Provides momentum filter so signals align with short-term M5 trend
    if (m5Candles.length >= EMA50_PERIOD) {
      const m5Closes = m5Candles.map((c) => c.close);
      const m5Ema20 = calcEMA(m5Closes, EMA20_PERIOD);
      const m5Ema50 = calcEMA(m5Closes, EMA50_PERIOD);
      const lastEma20 = m5Ema20[m5Ema20.length - 1];
      const lastEma50 = m5Ema50[m5Ema50.length - 1];
      if (!isNaN(lastEma20) && !isNaN(lastEma50)) {
        if (trendDir === "Bullish" && lastEma20 <= lastEma50) return null;
        if (trendDir === "Bearish" && lastEma20 >= lastEma50) return null;
      }
    }

    // ④ Rejection pin bar atau Engulfing pattern (keduanya sudah diperlonggar)
    const isRejection = checkRejection(closedM5, trendDir, fibLevels);
    const isEngulfing = checkEngulfing(prevM5, closedM5, trendDir);
    if (!isRejection && !isEngulfing) return null;

    const confirmationType: ConfirmationType = isEngulfing ? "engulfing" : "rejection";

    const sl = trendDir === "Bullish" ? fibLevels.swingLow : fibLevels.swingHigh;
    const slDistance = Math.abs(currentPrice - sl);
    if (slDistance < atr * 0.1 || atr < 0.1) return null;

    // TP realistis scalping XAUUSD M5:
    // - Minimum RR 1:1.5 dari SL distance (scalping discipline)
    // - Fibonacci extension digunakan jika lebih jauh dari minimum RR
    // - Cap 60 pts dari entry agar tetap realistis untuk scalping
    const extDist = Math.abs(fibLevels.extensionNeg27 - currentPrice);
    const minRRDist = slDistance * 1.5;
    const atpDist = Math.min(Math.max(extDist, minRRDist, 10), 60);
    const tp = trendDir === "Bearish"
      ? currentPrice - atpDist
      : currentPrice + atpDist;

    const riskAmount = balance * 0.01;
    const lotSize = riskAmount / slDistance;
    const tpDistance = Math.abs(tp - currentPrice);
    const riskReward = tpDistance / slDistance;

    const nowMs = Date.now();
    const sigKey = makeSignalKey(currentPrice, trend, nowMs);

    return {
      id: sigKey,
      pair: "XAUUSD",
      timeframe: "M15/M5",
      trend: trendDir,
      entryPrice: currentPrice,
      stopLoss: sl,
      takeProfit: tp,
      riskReward: Math.round(riskReward * 100) / 100,
      lotSize: Math.round(lotSize * 100) / 100,
      timestampUTC: new Date(nowMs).toUTCString(),
      fibLevels,
      status: "active",
      signalCandleEpoch: closedM5.epoch,
      confirmationType,
      outcome: "pending",
    };
  }, [fibLevels, atr, trend, currentPrice, m5Candles, balance, marketState, currentAnchorEpoch]);

  useEffect(() => {
    if (currentSignal && currentAnchorEpoch !== null) {
      saveSignal(currentSignal, currentSignal.id);
      lastSignaledAnchorRef.current = currentAnchorEpoch;
      lastSignaledTimeMsRef.current = Date.now();
      // Simpan sebagai activeSignal untuk TP/SL tracking
      setActiveSignal(currentSignal);
    }
  }, [currentSignal?.id, saveSignal, currentAnchorEpoch]);

  // Ketika anchor baru terbentuk, clear activeSignal yang lama
  // (anchor baru = sinyal baru akan menggantikan)
  useEffect(() => {
    setActiveSignal(null);
  }, [currentAnchorEpoch]);

  // ─── Notify when a NEW signal appears ─────────────────────────────────────
  const prevSignalIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!currentSignal) return;
    if (currentSignal.id === prevSignalIdRef.current) return;
    prevSignalIdRef.current = currentSignal.id;
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

    // Check TP hit
    if (!tpSlNotifiedRef.current.tp) {
      const tpHit = isBull
        ? currentPrice >= activeSignal.takeProfit
        : currentPrice <= activeSignal.takeProfit;
      if (tpHit) {
        tpSlNotifiedRef.current.tp = true;
        tpSlNotifiedRef.current.sl = true;
        updateSignalOutcome(activeSignal.id, "win");
        setActiveSignal(null);
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
            takeProfit: activeSignal.takeProfit,
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
        updateSignalOutcome(activeSignal.id, "loss");
        setActiveSignal(null);
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
    const demoId = `demo-${Date.now()}`;
    const demo: TradingSignal = {
      id: demoId,
      pair: "XAUUSD",
      timeframe: "M5",
      trend: isBuy ? "Bullish" : "Bearish",
      entryPrice: price,
      stopLoss: sl,
      takeProfit: tp,
      riskReward: rr,
      lotSize: 0.01,
      timestampUTC: new Date().toUTCString(),
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
      ema200,
      trend,
      fibLevels,
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
      m5Candles, m15Candles, currentPrice, ema50, ema200, trend,
      fibLevels, currentSignal, activeSignal, signalHistory, atr, connectionStatus,
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
