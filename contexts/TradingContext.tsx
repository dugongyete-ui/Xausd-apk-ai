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
// On web browser, use current page origin — works in dev preview AND published.
// On native (Expo Go / APK), fall back to EXPO_PUBLIC_DOMAIN.
const BACKEND_URL = (() => {
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
  ema200: number | null;
  trend: TrendState;
  fibLevels: FibLevels | null;
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
  // ─── Startup: unlock audio context on web ────────────────────────────────
  useEffect(() => {
    unlockAudioContext();
  }, []);

  // ─── Startup: load cached data + fetch real signals dari backend ──────────
  useEffect(() => {
    // Langkah 1: Tampilkan data cache (AsyncStorage) secepatnya
    Promise.all([
      AsyncStorage.getItem(STORAGE_KEY_SIGNALS),
      AsyncStorage.getItem(STORAGE_KEY_BALANCE),
      AsyncStorage.getItem(STORAGE_KEY_M15),
      AsyncStorage.getItem(STORAGE_KEY_M5),
    ]).then(([sigRaw, balRaw, m15Raw, m5Raw]) => {
      // Sinyal dari cache — ditampilkan langsung (offline fallback)
      if (sigRaw) {
        try {
          const cached = JSON.parse(sigRaw) as TradingSignal[];
          setSignalHistory(cached);
          cached.forEach((s) => savedSignalKeys.current.add(s.id));
          console.log(`[TradingContext] Loaded ${cached.length} cached signals`);
        } catch {}
      }

      // Balance
      if (balRaw) setBalanceState(parseFloat(balRaw) || 10000);

      // M15 candles
      if (m15Raw) {
        try {
          const parsed: Candle[] = JSON.parse(m15Raw);
          if (parsed.length >= EMA200_PERIOD) setM15Candles(parsed);
        } catch {}
      }

      // M5 candles
      if (m5Raw) {
        try {
          const parsed: Candle[] = JSON.parse(m5Raw);
          if (parsed.length > 0) {
            setM5Candles(parsed);
            setCurrentPrice(parsed[parsed.length - 1].close);
          }
        } catch {}
      }

      // Langkah 2: Fetch sinyal REAL dari backend server (berjalan 24/7)
      // Backend terus generate sinyal meskipun device offline
      fetch(`${BACKEND_URL}/api/signals`)
        .then((r) => r.json())
        .then((serverSignals: TradingSignal[]) => {
          if (!Array.isArray(serverSignals) || serverSignals.length === 0) return;

          // Merge sinyal server dengan cache lokal — server selalu lebih otoritatif
          setSignalHistory((prev) => {
            const existingIds = new Set(prev.map((s) => s.id));
            const newFromServer = serverSignals.filter((s) => !existingIds.has(s.id));

            // Gabungkan, urutkan dari yang paling baru
            const merged = [...serverSignals];
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
          if (!Array.isArray(serverSignals) || serverSignals.length === 0) return;
          setSignalHistory((prev) => {
            const existingIds = new Set(prev.map((s) => s.id));
            const newOnes = serverSignals.filter((s) => !existingIds.has(s.id));
            if (newOnes.length === 0) return prev;
            const merged = [...serverSignals].sort(
              (a, b) => new Date(b.timestampUTC).getTime() - new Date(a.timestampUTC).getTime()
            );
            merged.forEach((s) => savedSignalKeys.current.add(s.id));
            AsyncStorage.setItem(STORAGE_KEY_SIGNALS, JSON.stringify(merged)).catch(() => {});
            console.log(`[TradingContext] Sync: +${newOnes.length} sinyal baru dari server`);
            return merged;
          });
        })
        .catch(() => {});
    };

    const syncTimer = setInterval(fetchAndMergeSignals, 3 * 60 * 1000);
    return () => clearInterval(syncTimer);

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
    if (m15Candles.length < EMA200_PERIOD) {
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
    const check = (fib: FibLevels | null) => {
      if (!fib) return false;
      const lo = Math.min(fib.level618, fib.level786);
      const hi = Math.max(fib.level618, fib.level786);
      return currentPrice >= lo && currentPrice <= hi;
    };
    return check(bullFibLevels) || check(bearFibLevels);
  }, [bullFibLevels, bearFibLevels, currentPrice]);

  // ─── Signal detection: M15 zone + M5 confirmation — UNLIMITED ────────────
  // ① Evaluasi candle M5 CLOSED (m5Candles[n-2])
  // ② Zone check diperluas: 50%–88.6% dari swing range
  // ③ Rejection: wick ≥ 0.8× body, Engulfing: partial 75% engulf
  // ④ Dedup: 1 sinyal per candle M5 closed (epoch-based), tanpa cooldown waktu
  const currentSignal = useMemo((): TradingSignal | null => {
    if (
      !fibLevels || !fibTrend || !atr || atr <= 0 ||
      m5Candles.length < 3 || currentPrice === null ||
      marketState === "closed" || currentAnchorEpoch === null
    ) return null;

    // ① Gunakan candle CLOSED: n-2 (candle closed terakhir), n-3 (sebelumnya)
    const closedM5 = m5Candles[m5Candles.length - 2];
    const prevM5   = m5Candles[m5Candles.length - 3];
    const trendDir = fibTrend;

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

    // TP1 (scalping cepat): 1:1 RR dari SL, maks 15 pts — exit cepat sebelum pullback
    const tp1Dist = Math.min(slDistance * 1.0, 15);
    const tp1 = trendDir === "Bearish"
      ? currentPrice - tp1Dist
      : currentPrice + tp1Dist;

    // TP2 (full target): 1.8:1 RR, cap 28 pts untuk scalping realistis
    const tp2Dist = Math.min(Math.max(slDistance * 1.8, 10), 28);
    const tp2 = trendDir === "Bearish"
      ? currentPrice - tp2Dist
      : currentPrice + tp2Dist;

    const riskAmount = balance * 0.01;
    const lotSize = riskAmount / slDistance;
    const rr1 = tp1Dist / slDistance;
    const rr2 = tp2Dist / slDistance;

    const nowMs = Date.now();
    // Signal ID berdasarkan epoch candle M5 — dedup alami tanpa cooldown waktu
    const sigKey = `${closedM5.epoch}_${trendDir}`;

    return {
      id: sigKey,
      pair: "XAUUSD",
      timeframe: "M15/M5",
      trend: trendDir,
      entryPrice: currentPrice,
      stopLoss: sl,
      takeProfit: tp1,
      takeProfit2: tp2,
      riskReward: Math.round(rr1 * 100) / 100,
      riskReward2: Math.round(rr2 * 100) / 100,
      lotSize: Math.round(lotSize * 100) / 100,
      timestampUTC: toWIBString(new Date(nowMs)),
      fibLevels,
      status: "active",
      signalCandleEpoch: closedM5.epoch,
      confirmationType,
      outcome: "pending",
    };
  }, [fibLevels, fibTrend, atr, currentPrice, m5Candles, balance, marketState, currentAnchorEpoch]);

  useEffect(() => {
    if (currentSignal) {
      saveSignal(currentSignal, currentSignal.id);
      lastSignaledCandleEpochRef.current = currentSignal.signalCandleEpoch ?? null;
      // Simpan sebagai activeSignal untuk TP/SL tracking
      setActiveSignal(currentSignal);
    }
  }, [currentSignal?.id, saveSignal]);

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
      ema200,
      trend,
      fibLevels,
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
      m5Candles, m15Candles, currentPrice, ema50, ema200, trend,
      fibLevels, fibTrend, currentSignal, activeSignal, signalHistory, atr, connectionStatus,
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
