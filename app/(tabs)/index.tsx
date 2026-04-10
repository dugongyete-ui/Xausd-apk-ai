import React, { useRef, useEffect } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  Platform,
  Animated,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import C from "@/constants/colors";
import { useTrading, TrendState, FibLevels, TradingSignal } from "@/contexts/TradingContext";
import { FibChart } from "@/components/FibChart";

// Masalah 4f: Skeleton loading placeholder dengan animasi fade
function SkeletonBox({ width, height, style }: { width?: number | string; height?: number; style?: object }) {
  const opacity = useRef(new Animated.Value(0.3)).current;
  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.7, duration: 700, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.3, duration: 700, useNativeDriver: true }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [opacity]);
  return (
    <Animated.View
      style={[
        { width: width ?? "100%", height: height ?? 16, borderRadius: 8, backgroundColor: C.border },
        { opacity },
        style,
      ]}
    />
  );
}

function RegimeBadge({ regime }: { regime?: TradingSignal["marketRegime"] }) {
  if (!regime) return null;
  const config =
    regime === "trending"
      ? { color: "#22c55e", bg: "rgba(34,197,94,0.12)", label: "TRENDING" }
      : regime === "ranging"
      ? { color: "#f59e0b", bg: "rgba(245,158,11,0.12)", label: "RANGING" }
      : { color: "#6b7280", bg: "rgba(107,114,128,0.10)", label: "UNKNOWN" };
  return (
    <View style={[regimeBadgeStyles.badge, { backgroundColor: config.bg }]}>
      <View style={[regimeBadgeStyles.dot, { backgroundColor: config.color }]} />
      <Text style={[regimeBadgeStyles.text, { color: config.color }]}>{config.label}</Text>
    </View>
  );
}

const regimeBadgeStyles = StyleSheet.create({
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 20,
    alignSelf: "flex-start",
  },
  dot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
  },
  text: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 8,
    letterSpacing: 0.8,
  },
});

// ─── Live Clock ───────────────────────────────────────────────────────────────
function LiveClock() {
  const [now, setNow] = React.useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const pad = (n: number) => String(n).padStart(2, "0");

  // WIB = UTC+7
  const wibOffset = 7 * 60 * 60 * 1000;
  const wibDate = new Date(now.getTime() + wibOffset);

  const wibHH = pad(wibDate.getUTCHours());
  const wibMM = pad(wibDate.getUTCMinutes());
  const wibSS = pad(wibDate.getUTCSeconds());

  // Tanggal WIB
  const days = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"];
  const months = ["Jan","Feb","Mar","Apr","Mei","Jun","Jul","Agu","Sep","Okt","Nov","Des"];
  const dayName = days[wibDate.getUTCDay()];
  const dateStr = `${dayName}, ${wibDate.getUTCDate()} ${months[wibDate.getUTCMonth()]} ${wibDate.getUTCFullYear()}`;

  return (
    <View style={clockStyles.wrapper}>
      {/* Jam digital utama (WIB) */}
      <View style={clockStyles.timeRow}>
        <Text style={clockStyles.hhmm}>{wibHH}:{wibMM}</Text>
        <Text style={clockStyles.ss}>{wibSS}</Text>
      </View>
      {/* Tanggal */}
      <Text style={clockStyles.date}>{dateStr}</Text>
      {/* WIB label */}
      <View style={clockStyles.utcRow}>
        <View style={clockStyles.utcDot} />
        <Text style={clockStyles.utc}>WIB (UTC+7)</Text>
      </View>
    </View>
  );
}

const clockStyles = StyleSheet.create({
  wrapper: {
    alignItems: "flex-end",
  },
  timeRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 2,
  },
  hhmm: {
    fontFamily: "Inter_700Bold",
    fontSize: 26,
    color: C.text,
    letterSpacing: -0.5,
    lineHeight: 30,
  },
  ss: {
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    color: C.textSub,
    lineHeight: 20,
    marginBottom: 1,
    letterSpacing: 0.5,
  },
  date: {
    fontFamily: "Inter_400Regular",
    fontSize: 10,
    color: C.textDim,
    marginTop: 1,
  },
  utcRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 2,
  },
  utcDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: C.gold,
  },
  utc: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 9,
    color: C.gold,
    letterSpacing: 0.8,
  },
});

function PulseDot({ color }: { color: string }) {
  const anim = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(anim, {
          toValue: 0.3,
          duration: 800,
          useNativeDriver: Platform.OS !== "web",
        }),
        Animated.timing(anim, {
          toValue: 1,
          duration: 800,
          useNativeDriver: Platform.OS !== "web",
        }),
      ])
    ).start();
  }, [anim]);
  return (
    <Animated.View
      style={{
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: color,
        opacity: anim,
      }}
    />
  );
}

function ConnectionBar({
  status,
  marketState,
}: {
  status: "connecting" | "connected" | "disconnected";
  marketState: "open" | "closed";
}) {
  const color =
    marketState === "closed"
      ? C.textDim
      : status === "connected"
      ? C.green
      : status === "connecting"
      ? C.gold
      : C.red;
  const label =
    marketState === "closed"
      ? "CLOSED"
      : status === "connected"
      ? "LIVE"
      : status === "connecting"
      ? "CONNECTING"
      : "OFFLINE";
  return (
    <View style={styles.statusRow}>
      <PulseDot color={color} />
      <Text style={[styles.statusLabel, { color }]}>{label}</Text>
      <Text style={styles.statusPair}>XAUUSD · M15/M5</Text>
    </View>
  );
}

function TrendBadge({ trend }: { trend: TrendState }) {
  const config: Record<
    TrendState,
    { color: string; bg: string; icon: "trending-up" | "trending-down" | "remove" | "hourglass" }
  > = {
    Bullish: { color: C.green, bg: C.greenBg, icon: "trending-up" },
    Bearish: { color: C.red, bg: C.redBg, icon: "trending-down" },
    "No Trade": { color: C.textSub, bg: C.card, icon: "remove" },
    Loading: { color: C.textSub, bg: C.card, icon: "hourglass" },
  };
  const cfg = config[trend];
  return (
    <View
      style={[
        styles.trendBadge,
        { backgroundColor: cfg.bg, borderColor: cfg.color + "30" },
      ]}
    >
      <Ionicons name={cfg.icon} size={14} color={cfg.color} />
      <Text style={[styles.trendText, { color: cfg.color }]}>
        {trend.toUpperCase()}
      </Text>
    </View>
  );
}

function MarketClosedBanner() {
  const { marketState, marketNextOpen } = useTrading();
  if (marketState === "open") return null;
  const isMaintenanceMsg = marketNextOpen.includes("maintenance");
  return (
    <View style={styles.marketClosedBanner}>
      <Ionicons name={isMaintenanceMsg ? "construct" : "moon"} size={16} color={C.textDim} />
      <View style={{ flex: 1 }}>
        <Text style={styles.marketClosedTitle}>
          {isMaintenanceMsg ? "Deriv Maintenance" : "Pasar Tutup — Weekend"}
        </Text>
        {!!marketNextOpen && (
          <Text style={styles.marketClosedSub}>{marketNextOpen}</Text>
        )}
      </View>
    </View>
  );
}

function PriceCard() {
  const { currentPrice, trend, connectionStatus, candles, marketState } = useTrading();
  const prevPrice =
    candles.length > 1 ? candles[candles.length - 2].close : null;
  const delta =
    currentPrice !== null && prevPrice !== null
      ? currentPrice - prevPrice
      : null;
  const isUp = delta !== null && delta >= 0;

  return (
    <View style={styles.priceCard}>
      <View style={styles.priceRow}>
        <Text style={styles.priceLabel}>GOLD / USD</Text>
        <ConnectionBar status={connectionStatus} marketState={marketState} />
      </View>
      {currentPrice !== null ? (
        <>
          <Text style={styles.priceValue}>{currentPrice.toFixed(2)}</Text>
          {delta !== null && (
            <View style={styles.deltaRow}>
              <Ionicons
                name={isUp ? "arrow-up" : "arrow-down"}
                size={14}
                color={isUp ? C.green : C.red}
              />
              <Text style={[styles.deltaText, { color: isUp ? C.green : C.red }]}>
                {Math.abs(delta).toFixed(2)}{" "}
                ({delta >= 0 ? "+" : ""}
                {prevPrice
                  ? ((delta / prevPrice) * 100).toFixed(3)
                  : 0}
                %)
              </Text>
            </View>
          )}
        </>
      ) : (
        <View style={styles.priceSkeleton} />
      )}
      <View style={styles.trendRow}>
        <Text style={styles.trendLabel}>TREND</Text>
        <TrendBadge trend={trend} />
      </View>
    </View>
  );
}

function EMARow() {
  const { ema50, m15Candles, candles } = useTrading();
  const lastClose = m15Candles.length > 0 ? m15Candles[m15Candles.length - 1].close : null;

  return (
    <View style={styles.emaRow}>
      {/* EMA 50 from M15 */}
      <View style={styles.emaItem}>
        <Text style={styles.emaLabel}>EMA50·M15</Text>
        {ema50 !== null ? (
          <Text style={[styles.emaValue, { color: lastClose !== null && ema50 < lastClose ? C.green : C.red }]}>
            {ema50.toFixed(1)}
          </Text>
        ) : (
          <Text style={[styles.emaValue, { color: C.textDim }]}>—</Text>
        )}
      </View>
      {/* M5 candle count */}
      <View style={styles.emaItem}>
        <Text style={styles.emaLabel}>M5</Text>
        <Text style={[styles.emaValue, { color: candles.length > 0 ? C.green : C.textDim }]}>
          {candles.length}/200
        </Text>
      </View>
    </View>
  );
}

function FibSetupCard({
  fib,
  dir,
  currentPrice,
  atr,
}: {
  fib: FibLevels;
  dir: "Bullish" | "Bearish";
  currentPrice: number | null;
  atr: number | null;
}) {
  const isBull = dir === "Bullish";
  const SWING_COLOR = "#C084FC";
  const ZONE786_COLOR = "#F97316";
  const trendColor = isBull ? C.green : C.red;

  const range = Math.abs(fib.swingHigh - fib.swingLow);
  const entryLo = isBull ? fib.swingHigh - range * 0.886 : fib.swingLow + range * 0.50;
  const entryHi = isBull ? fib.swingHigh - range * 0.50  : fib.swingLow + range * 0.886;
  const priceInThisZone =
    currentPrice !== null && currentPrice >= entryLo && currentPrice <= entryHi;

  const levels = isBull
    ? [
        { label: "0.0% · Swing High (Pivot)",  value: fib.swingHigh,               color: SWING_COLOR,  pct: "0.0%"  },
        { label: "50.0% · Entry Zone Start",   value: fib.swingHigh - range * 0.50, color: "#94A3B8",   pct: "50.0%" },
        { label: "61.8% · Golden Retracement", value: fib.level618,                 color: C.gold,       pct: "61.8%" },
        { label: "78.6% · Deep Retracement",   value: fib.level786,                 color: ZONE786_COLOR, pct: "78.6%" },
        { label: "88.6% · Entry Zone End",     value: fib.swingHigh - range * 0.886, color: "#94A3B8",  pct: "88.6%" },
        { label: "100% · Swing Low (SL Ref)",  value: fib.swingLow,                 color: C.red,        pct: "100%"  },
      ]
    : [
        { label: "0.0% · Swing Low (Pivot)",   value: fib.swingLow,                 color: SWING_COLOR,  pct: "0.0%"  },
        { label: "50.0% · Entry Zone Start",   value: fib.swingLow + range * 0.50,  color: "#94A3B8",   pct: "50.0%" },
        { label: "61.8% · Golden Retracement", value: fib.level618,                 color: C.gold,       pct: "61.8%" },
        { label: "78.6% · Deep Retracement",   value: fib.level786,                 color: ZONE786_COLOR, pct: "78.6%" },
        { label: "88.6% · Entry Zone End",     value: fib.swingLow + range * 0.886, color: "#94A3B8",   pct: "88.6%" },
        { label: "100% · Swing High (SL Ref)", value: fib.swingHigh,                color: C.red,        pct: "100%"  },
      ];

  return (
    <View style={[styles.fibCard, { marginBottom: 10 }]}>
      <View style={[styles.fibSetupHeader, { borderLeftColor: trendColor }]}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Ionicons
            name={isBull ? "trending-up" : "trending-down"}
            size={13}
            color={trendColor}
          />
          <Text style={[styles.fibSetupTitle, { color: trendColor }]}>
            {isBull ? "BUY Setup (Bullish)" : "SELL Setup (Bearish)"}
          </Text>
        </View>
        {priceInThisZone && (
          <View style={styles.zoneBadge}>
            <PulseDot color={trendColor} />
            <Text style={[styles.zoneText, { color: trendColor }]}>IN ZONE</Text>
          </View>
        )}
      </View>
      {levels.map((lvl, i) => {
        const isCurrent =
          currentPrice !== null && Math.abs(currentPrice - lvl.value) < 0.5;
        return (
          <View
            key={i}
            style={[
              styles.fibRow,
              i < levels.length - 1 && styles.fibRowBorder,
              isCurrent && { backgroundColor: lvl.color + "15" },
            ]}
          >
            <View style={[styles.fibDot, { backgroundColor: lvl.color }]} />
            <View style={styles.fibInfo}>
              <Text style={styles.fibLevelLabel}>{lvl.label}</Text>
              <Text style={styles.fibPct}>{lvl.pct}</Text>
            </View>
            <Text style={[styles.fibValue, { color: lvl.color }]}>
              {lvl.value.toFixed(2)}
            </Text>
          </View>
        );
      })}
      {atr !== null && (
        <View style={[styles.fibRow, { borderTopWidth: 1, borderTopColor: C.border }]}>
          <View style={[styles.fibDot, { backgroundColor: C.textDim }]} />
          <View style={styles.fibInfo}>
            <Text style={styles.fibLevelLabel}>ATR (14)</Text>
            <Text style={styles.fibPct}>Volatility</Text>
          </View>
          <Text style={[styles.fibValue, { color: C.textSub }]}>{atr.toFixed(3)}</Text>
        </View>
      )}
    </View>
  );
}

function FibLevelsCard() {
  const { bullFibLevels, bearFibLevels, currentPrice, inZone, atr } = useTrading();

  if (!bullFibLevels && !bearFibLevels) {
    return null;
  }

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>FIBONACCI LEVELS</Text>
        {inZone && (
          <View style={styles.zoneBadge}>
            <PulseDot color={C.gold} />
            <Text style={styles.zoneText}>IN ZONE 50–88.6%</Text>
          </View>
        )}
      </View>
      {bullFibLevels && (
        <FibSetupCard
          fib={bullFibLevels}
          dir="Bullish"
          currentPrice={currentPrice}
          atr={atr}
        />
      )}
      {bearFibLevels && (
        <FibSetupCard
          fib={bearFibLevels}
          dir="Bearish"
          currentPrice={currentPrice}
          atr={atr}
        />
      )}
    </View>
  );
}

function FloatingProfitCounter({ signal, currentPrice }: { signal: TradingSignal; currentPrice: number | null }) {
  const isBull = signal.trend === "Bullish";
  const floatingPts =
    currentPrice !== null
      ? isBull
        ? currentPrice - signal.entryPrice
        : signal.entryPrice - currentPrice
      : null;

  const isProfit = floatingPts !== null && floatingPts > 0;
  const isBreakeven = floatingPts !== null && Math.abs(floatingPts) < 0.5;
  const profitColor = isBreakeven ? C.gold : isProfit ? C.green : C.red;
  const profitLabel = isBreakeven ? "ZERO FLOATING" : isProfit ? "PROFIT RUNNING" : "DRAWDOWN";

  return (
    <View style={floatStyles.wrapper}>
      <View style={[floatStyles.labelRow, { backgroundColor: profitColor + "18" }]}>
        <View style={[floatStyles.dot, { backgroundColor: profitColor }]} />
        <Text style={[floatStyles.label, { color: profitColor }]}>{profitLabel}</Text>
      </View>
      <View style={floatStyles.ptsRow}>
        <Text style={[floatStyles.pts, { color: profitColor }]}>
          {floatingPts !== null
            ? `${floatingPts >= 0 ? "+" : ""}${floatingPts.toFixed(2)} pts`
            : "—"}
        </Text>
        {currentPrice !== null && (
          <Text style={floatStyles.nowPrice}>@ {currentPrice.toFixed(2)}</Text>
        )}
      </View>
    </View>
  );
}

const floatStyles = StyleSheet.create({
  wrapper: {
    gap: 4,
  },
  labelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    alignSelf: "flex-start",
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  label: {
    fontFamily: "Inter_700Bold",
    fontSize: 9,
    letterSpacing: 1.2,
  },
  ptsRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 6,
  },
  pts: {
    fontFamily: "Orbitron_700Bold",
    fontSize: 22,
    letterSpacing: -0.5,
  },
  nowPrice: {
    fontFamily: "Inter_400Regular",
    fontSize: 11,
    color: "#6b7280",
  },
});

function BreakevenBadge() {
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.4, duration: 600, useNativeDriver: Platform.OS !== "web" }),
        Animated.timing(pulse, { toValue: 1, duration: 600, useNativeDriver: Platform.OS !== "web" }),
      ])
    ).start();
  }, [pulse]);
  return (
    <View style={beStyles.badge}>
      <Animated.View style={[beStyles.dot, { opacity: pulse }]} />
      <Text style={beStyles.text}>BREAKEVEN LOCKED · TP1 HIT</Text>
    </View>
  );
}

const beStyles = StyleSheet.create({
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "rgba(16,185,129,0.15)",
    borderWidth: 1,
    borderColor: "rgba(16,185,129,0.35)",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 10,
    alignSelf: "flex-start",
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: "#10b981",
  },
  text: {
    fontFamily: "Inter_700Bold",
    fontSize: 9,
    color: "#10b981",
    letterSpacing: 1.1,
  },
});

function SignalCard() {
  const { activeSignal, inZone, trend, m15Candles, currentPrice } = useTrading();

  if (!activeSignal || activeSignal.outcome === "win" || activeSignal.outcome === "loss" || activeSignal.outcome === "expired") {
    if (trend === "Loading" && m15Candles.length < 50) {
      return (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>SIGNAL  ·  M15/M5</Text>
          <View style={styles.noSignalCard}>
            <SkeletonBox height={14} width="60%" style={{ marginBottom: 10, alignSelf: "center" }} />
            <SkeletonBox height={11} width="80%" style={{ marginBottom: 6, alignSelf: "center" }} />
            <SkeletonBox height={11} width="50%" style={{ alignSelf: "center" }} />
          </View>
        </View>
      );
    }

    const loadMsg =
      trend === "Loading"
        ? `Memuat M15: ${m15Candles.length}/300 candle (EMA50 siap setelah 50)...`
        : trend === "No Trade"
        ? "Trend belum jelas — harga terlalu dekat EMA50 M15"
        : inZone
        ? "Harga di zona entry 50–88.6% — tunggu konfirmasi M5 (rejection/engulfing)"
        : "Harga belum masuk zona entry Fibonacci 50–88.6% (M15)";

    return (
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>SIGNAL  ·  M15/M5</Text>
        <View style={styles.noSignalCard}>
          <View style={styles.noSignalIcon}>
            <Ionicons name="shield-checkmark" size={28} color={C.textDim} />
          </View>
          <Text style={styles.noSignalTitle}>Belum Ada Sinyal</Text>
          <Text style={styles.noSignalSub}>{loadMsg}</Text>
        </View>
      </View>
    );
  }

  const isBull = activeSignal.trend === "Bullish";
  const trendColor = isBull ? C.green : C.red;

  const isBreakevenMode = activeSignal.effectiveSL !== undefined;
  const displaySL = isBreakevenMode ? activeSignal.effectiveSL! : activeSignal.stopLoss;
  const slLabel = isBreakevenMode ? "BE" : "SL";
  const slColor = isBreakevenMode ? "#10b981" : C.red;

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>ACTIVE SIGNAL</Text>
        <View
          style={[
            styles.signalBadge,
            {
              backgroundColor: trendColor + "20",
              borderColor: trendColor + "50",
            },
          ]}
        >
          <Ionicons
            name={isBull ? "trending-up" : "trending-down"}
            size={12}
            color={trendColor}
          />
          <Text style={[styles.signalBadgeText, { color: trendColor }]}>
            {activeSignal.trend.toUpperCase()}
          </Text>
        </View>
      </View>
      <View style={[styles.signalCard, { borderColor: isBreakevenMode ? "#10b98150" : trendColor + "40" }]}>

        {/* Breakeven locked banner */}
        {isBreakevenMode && (
          <View style={{ marginBottom: 10 }}>
            <BreakevenBadge />
          </View>
        )}

        {/* Live floating profit/loss counter */}
        <View style={{ marginBottom: 12 }}>
          <FloatingProfitCounter signal={activeSignal} currentPrice={currentPrice} />
        </View>

        {/* Confirmation type badge */}
        <View style={styles.confirmRow}>
          <View style={[styles.confirmBadge, { backgroundColor: trendColor + "18" }]}>
            <Ionicons
              name={activeSignal.confirmationType === "engulfing" ? "layers" : "radio-button-on"}
              size={11}
              color={trendColor}
            />
            <Text style={[styles.confirmText, { color: trendColor }]}>
              {activeSignal.confirmationType === "engulfing" ? "ENGULFING M5" : "REJECTION M5"}
            </Text>
          </View>
          <RegimeBadge regime={activeSignal.marketRegime} />
          <Text style={styles.confirmSub}>Zona M15 · Konfirmasi M5</Text>
        </View>
        <View style={styles.signalMainRow}>
          <View>
            <Text style={styles.signalPriceLabel}>ENTRY</Text>
            <Text style={[styles.signalPriceValue, { color: trendColor }]}>
              {activeSignal.entryPrice.toFixed(2)}
            </Text>
          </View>
          <View style={styles.rrBlock}>
            <Text style={styles.rrLabel}>R:R</Text>
            <Text style={styles.rrValue}>1:{activeSignal.riskReward}</Text>
          </View>
        </View>
        <View style={styles.signalDivider} />
        <View style={styles.signalLevelsRow}>
          <View style={styles.signalLevel}>
            <View style={[styles.levelDot, { backgroundColor: slColor }]} />
            <Text style={[styles.levelKey, { color: isBreakevenMode ? "#10b981" : undefined }]}>{slLabel}</Text>
            <Text style={[styles.levelVal, { color: slColor }]}>
              {displaySL.toFixed(2)}
            </Text>
          </View>
          <View style={styles.signalLevel}>
            <View style={[styles.levelDot, { backgroundColor: C.green }]} />
            <Text style={styles.levelKey}>TP1</Text>
            <Text style={[styles.levelVal, { color: isBreakevenMode ? "#6b7280" : C.green, textDecorationLine: isBreakevenMode ? "line-through" : "none" }]}>
              {activeSignal.takeProfit.toFixed(2)}
            </Text>
          </View>
          {activeSignal.takeProfit2 && (
            <View style={styles.signalLevel}>
              <View style={[styles.levelDot, { backgroundColor: "#4ade80" }]} />
              <Text style={styles.levelKey}>TP2</Text>
              <Text style={[styles.levelVal, { color: "#4ade80" }]}>
                {activeSignal.takeProfit2.toFixed(2)}
              </Text>
            </View>
          )}
          <View style={styles.signalLevel}>
            <View style={[styles.levelDot, { backgroundColor: C.blue }]} />
            <Text style={styles.levelKey}>LOT</Text>
            <Text style={[styles.levelVal, { color: C.blue }]}>
              {activeSignal.lotSize.toFixed(2)}
            </Text>
          </View>
        </View>
        <Text style={styles.signalTime}>{activeSignal.timestampUTC}</Text>
      </View>
    </View>
  );
}

export default function DashboardScreen() {
  const insets = useSafeAreaInsets();
  const topPad = Platform.OS === "web" ? 67 : insets.top;
  const botPad = Platform.OS === "web" ? 84 : insets.bottom + 60;

  return (
    <View style={[styles.container, { paddingTop: topPad }]}>
      <ScrollView
        contentContainerStyle={{
          paddingBottom: botPad + 16,
          paddingHorizontal: 16,
        }}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <MaterialCommunityIcons name="finance" size={24} color={C.gold} />
            <View>
              <Text style={styles.headerTitle}>LIBARTIN</Text>
              <Text style={styles.headerSub}>by Dzeck X Wakassim</Text>
            </View>
          </View>
          <LiveClock />
        </View>

        <MarketClosedBanner />
        <PriceCard />
        <EMARow />

        {/* Chart always visible */}
        <View style={styles.section}>
          <FibChart />
        </View>

        <FibLevelsCard />
        <SignalCard />

      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 16,
    paddingTop: 8,
  },
  headerTitle: {
    fontFamily: "Orbitron_900Black",
    fontSize: 18,
    color: C.gold,
    letterSpacing: 2,
  },
  headerSub: {
    fontFamily: "Inter_400Regular",
    fontSize: 11,
    color: C.textSub,
    marginTop: 2,
    letterSpacing: 0.3,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  statusLabel: {
    fontFamily: "Inter_700Bold",
    fontSize: 10,
    letterSpacing: 1,
  },
  statusPair: {
    fontFamily: "Inter_500Medium",
    fontSize: 10,
    color: C.textDim,
    marginLeft: 4,
  },
  priceCard: {
    backgroundColor: C.card,
    borderRadius: 16,
    padding: 20,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: C.border,
  },
  priceRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  priceLabel: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 12,
    color: C.textDim,
    letterSpacing: 1.5,
  },
  priceValue: {
    fontFamily: "Inter_700Bold",
    fontSize: 40,
    color: C.text,
    letterSpacing: -1,
  },
  priceSkeleton: {
    height: 48,
    borderRadius: 8,
    backgroundColor: C.cardAlt,
    marginVertical: 4,
  },
  deltaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 4,
    marginBottom: 12,
  },
  deltaText: {
    fontFamily: "Inter_500Medium",
    fontSize: 13,
  },
  trendRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: C.border,
  },
  trendLabel: {
    fontFamily: "Inter_500Medium",
    fontSize: 11,
    color: C.textDim,
    letterSpacing: 1.2,
  },
  trendBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: 1,
  },
  trendText: {
    fontFamily: "Inter_700Bold",
    fontSize: 11,
    letterSpacing: 1,
  },
  emaRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 12,
  },
  emaItem: {
    flex: 1,
    backgroundColor: C.card,
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: C.border,
    alignItems: "center",
  },
  emaLabel: {
    fontFamily: "Inter_500Medium",
    fontSize: 10,
    color: C.textDim,
    letterSpacing: 1,
    marginBottom: 4,
  },
  emaValue: {
    fontFamily: "Inter_700Bold",
    fontSize: 13,
    color: C.text,
  },
  section: { marginBottom: 12 },
  sectionTitle: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 11,
    color: C.textDim,
    letterSpacing: 1.5,
    marginBottom: 8,
  },
  sectionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  fibCard: {
    backgroundColor: C.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: C.border,
    overflow: "hidden",
  },
  fibSetupHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
    borderLeftWidth: 3,
    backgroundColor: C.cardAlt,
  },
  fibSetupTitle: {
    fontFamily: "Inter_700Bold",
    fontSize: 12,
    letterSpacing: 0.5,
  },
  fibRow: {
    flexDirection: "row",
    alignItems: "center",
    padding: 14,
    gap: 12,
  },
  fibRowBorder: {
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  fibDot: { width: 8, height: 8, borderRadius: 4 },
  fibInfo: { flex: 1 },
  fibLevelLabel: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
    color: C.text,
  },
  fibPct: {
    fontFamily: "Inter_400Regular",
    fontSize: 11,
    color: C.textDim,
    marginTop: 1,
  },
  fibValue: {
    fontFamily: "Inter_700Bold",
    fontSize: 15,
    letterSpacing: 0.3,
  },
  zoneBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: C.goldBg,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
  },
  zoneText: {
    fontFamily: "Inter_700Bold",
    fontSize: 10,
    color: C.gold,
    letterSpacing: 1,
  },
  noSignalCard: {
    backgroundColor: C.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: C.border,
    padding: 28,
    alignItems: "center",
    gap: 8,
  },
  noSignalIcon: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: C.cardAlt,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 4,
  },
  noSignalTitle: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 16,
    color: C.textSub,
  },
  noSignalSub: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    color: C.textDim,
    textAlign: "center",
    lineHeight: 18,
  },
  signalCard: {
    backgroundColor: C.card,
    borderRadius: 16,
    borderWidth: 1,
    padding: 16,
  },
  signalBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
    borderWidth: 1,
  },
  signalBadgeText: {
    fontFamily: "Inter_700Bold",
    fontSize: 10,
    letterSpacing: 0.8,
  },
  signalMainRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
    marginBottom: 14,
  },
  signalPriceLabel: {
    fontFamily: "Inter_500Medium",
    fontSize: 11,
    color: C.textDim,
    letterSpacing: 1,
    marginBottom: 2,
  },
  signalPriceValue: {
    fontFamily: "Inter_700Bold",
    fontSize: 30,
    letterSpacing: -0.5,
  },
  rrBlock: { alignItems: "flex-end" },
  rrLabel: {
    fontFamily: "Inter_500Medium",
    fontSize: 10,
    color: C.textDim,
    letterSpacing: 1,
  },
  rrValue: {
    fontFamily: "Inter_700Bold",
    fontSize: 20,
    color: C.gold,
  },
  signalDivider: {
    height: 1,
    backgroundColor: C.border,
    marginBottom: 14,
  },
  signalLevelsRow: {
    flexDirection: "row",
    justifyContent: "space-around",
    marginBottom: 12,
  },
  signalLevel: { alignItems: "center", gap: 4 },
  levelDot: { width: 6, height: 6, borderRadius: 3 },
  levelKey: {
    fontFamily: "Inter_500Medium",
    fontSize: 10,
    color: C.textDim,
    letterSpacing: 1,
  },
  levelVal: { fontFamily: "Inter_700Bold", fontSize: 14 },
  signalTime: {
    fontFamily: "Inter_400Regular",
    fontSize: 10,
    color: C.textDim,
    textAlign: "center",
  },
  confirmRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 14,
  },
  confirmBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 20,
  },
  confirmText: {
    fontFamily: "Inter_700Bold",
    fontSize: 10,
    letterSpacing: 0.8,
  },
  confirmSub: {
    fontFamily: "Inter_400Regular",
    fontSize: 10,
    color: C.textDim,
  },
  marketClosedBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: C.cardAlt,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.border,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 12,
  },
  marketClosedTitle: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
    color: C.textSub,
  },
  marketClosedSub: {
    fontFamily: "Inter_400Regular",
    fontSize: 11,
    color: C.textDim,
    marginTop: 2,
  },
});
