import React, { useMemo, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import Svg, {
  Rect,
  Line,
  Path,
  Text as SvgText,
  Polygon,
  Defs,
  LinearGradient,
  Stop,
  G,
} from "react-native-svg";
import C from "@/constants/colors";
import { useTrading, calcEMAFull } from "@/contexts/TradingContext";

const RIGHT_W = 84;
const TOP_PAD = 16;
const BOT_PAD = 16;

type TF = "M15" | "M5";
const VISIBLE: Record<TF, number> = { M15: 30, M5: 40 };

function priceToY(p: number, lo: number, hi: number, plotH: number): number {
  if (hi === lo) return plotH / 2;
  return TOP_PAD + ((hi - p) / (hi - lo)) * plotH;
}

function dashedPath(x1: number, y: number, x2: number, dash = 7, gap = 4): string {
  let d = "";
  let x = x1;
  let on = true;
  while (x < x2) {
    const end = Math.min(x + (on ? dash : gap), x2);
    if (on) d += `M${x.toFixed(1)},${y.toFixed(1)} L${end.toFixed(1)},${y.toFixed(1)} `;
    x = end;
    on = !on;
  }
  return d;
}

interface FibLineProps {
  pct: string;
  desc: string;
  price: number;
  color: string;
  lo: number;
  hi: number;
  plotH: number;
  plotW: number;
  dashed?: boolean;
  strokeWidth?: number;
}

function FibLine({ pct, desc, price, color, lo, hi, plotH, plotW, dashed = true, strokeWidth = 1.5 }: FibLineProps) {
  const chartTop = TOP_PAD;
  const chartBot = TOP_PAD + plotH;
  const y = priceToY(price, lo, hi, plotH);
  const inRange = y >= chartTop - 1 && y <= chartBot + 1;
  const rightX = plotW + 3;
  const rightW = RIGHT_W - 4;

  if (inRange) {
    const labelText = pct + " · " + desc;
    const labelW = Math.min(labelText.length * 5 + 4, plotW * 0.58);
    return (
      <G>
        {/* Left accent */}
        <Rect x={0} y={y - strokeWidth} width={3} height={strokeWidth * 2} fill={color} opacity={1} />

        {/* Line */}
        {dashed ? (
          <Path d={dashedPath(3, y, plotW)} stroke={color} strokeWidth={strokeWidth} opacity={0.9} />
        ) : (
          <Line x1={3} y1={y} x2={plotW} y2={y} stroke={color} strokeWidth={strokeWidth} opacity={1} />
        )}

        {/* Chart label near left */}
        <Rect x={5} y={y - 8} width={labelW} height={11} fill="#0A0E17" opacity={0.88} rx={2} />
        <SvgText x={8} y={y + 1} fill={color} fontSize={7.5} fontWeight="bold">{labelText}</SvgText>

        {/* Right panel — compact single row */}
        <Rect x={rightX} y={y - 9} width={rightW} height={18} fill="#0D1117" opacity={0.92} rx={2} />
        <Rect x={rightX} y={y - 9} width={2.5} height={18} fill={color} opacity={1} />
        <SvgText x={rightX + 5} y={y - 1} fill={color} fontSize={6.5} fontWeight="bold">{pct}</SvgText>
        <SvgText x={rightX + 5} y={y + 8} fill="#FFFFFF" fontSize={8} fontWeight="bold">{price.toFixed(2)}</SvgText>
      </G>
    );
  }

  // Out-of-range: edge badge only (compact)
  const isAbove = y < chartTop;
  const edgeY = isAbove ? chartTop + 1 : chartBot - 15;
  const badgeH = 13;

  return (
    <G>
      <Rect x={rightX} y={edgeY} width={rightW} height={badgeH} fill={color} opacity={0.85} rx={2} />
      <SvgText x={rightX + rightW / 2} y={edgeY + 9} fill="#fff" fontSize={6.5} fontWeight="bold" textAnchor="middle">
        {isAbove ? "▲" : "▼"} {pct} {price.toFixed(1)}
      </SvgText>
    </G>
  );
}

const LOT_SIZE = 0.01;
const CONTRACT_SIZE = 100;

function calcFloatingPnL(trend: "Bullish" | "Bearish", entryPrice: number, currentPrice: number): number {
  const diff = trend === "Bullish" ? currentPrice - entryPrice : entryPrice - currentPrice;
  return diff * CONTRACT_SIZE * LOT_SIZE;
}

export function FibChart() {
  const { candles, m15Candles, fibLevels, currentPrice, currentSignal, activeSignal, trend, atr } = useTrading();
  const [chartW, setChartW] = useState(0);
  const [selectedTF, setSelectedTF] = useState<TF>("M15");
  const visibleCount = VISIBLE[selectedTF];
  // Chart height: responsive to screen width, fixed proportion — clean and tight
  const CHART_HEIGHT = chartW > 0 ? Math.min(400, Math.max(300, Math.round(chartW * 0.88))) : 320;

  // ── Visible candles: on M15, window starts from swingHigh/swingLow candle ──
  const visibleCandles = useMemo(() => {
    const src = selectedTF === "M15" ? m15Candles : candles;
    if (src.length === 0) return [];

    // For M5, use fixed window
    if (selectedTF !== "M15" || !fibLevels) return src.slice(-visibleCount);

    // Find candle index where swingHigh occurred (by matching candle.high)
    let highIdx = -1;
    let lowIdx = -1;
    let bestHighDiff = Infinity;
    let bestLowDiff = Infinity;
    for (let i = 0; i < src.length; i++) {
      const hd = Math.abs(src[i].high - fibLevels.swingHigh);
      const ld = Math.abs(src[i].low - fibLevels.swingLow);
      if (hd < bestHighDiff) { bestHighDiff = hd; highIdx = i; }
      if (ld < bestLowDiff) { bestLowDiff = ld; lowIdx = i; }
    }

    // Start from the earlier of the two swing candles (with 2 candles of context)
    const startIdx = highIdx >= 0 && lowIdx >= 0
      ? Math.max(0, Math.min(highIdx, lowIdx) - 2)
      : src.length - visibleCount;

    const sliced = src.slice(startIdx);
    // Cap at 80 candles so they remain readable
    return sliced.length > 80 ? sliced.slice(-80) : sliced;
  }, [selectedTF, candles, m15Candles, visibleCount, fibLevels]);

  const ema50Series = useMemo(() => {
    if (selectedTF !== "M15" || m15Candles.length < 50) return [];
    const full = calcEMAFull(m15Candles.map((c) => c.close), 50);
    return full.slice(-visibleCandles.length);
  }, [selectedTF, m15Candles, visibleCandles.length]);

  const ema200Series = useMemo(() => {
    if (selectedTF !== "M15" || m15Candles.length < 200) return [];
    const full = calcEMAFull(m15Candles.map((c) => c.close), 200);
    return full.slice(-visibleCandles.length);
  }, [selectedTF, m15Candles, visibleCandles.length]);

  const m15Ema50Val = useMemo(() => {
    if (ema50Series.length === 0) return null;
    const v = ema50Series[ema50Series.length - 1];
    return isNaN(v) ? null : v;
  }, [ema50Series]);

  const m15Ema200Val = useMemo(() => {
    if (ema200Series.length === 0) return null;
    const v = ema200Series[ema200Series.length - 1];
    return isNaN(v) ? null : v;
  }, [ema200Series]);

  // ── Range: smart expansion — include fib levels but prevent huge empty gaps ──
  const { lo, hi } = useMemo(() => {
    if (visibleCandles.length === 0) return { lo: 3200, hi: 3300 };
    let loV = Math.min(...visibleCandles.map((c) => c.low));
    let hiV = Math.max(...visibleCandles.map((c) => c.high));
    if (currentPrice !== null) {
      loV = Math.min(loV, currentPrice);
      hiV = Math.max(hiV, currentPrice);
    }
    if (fibLevels) {
      // Candle window already includes swingHigh/swingLow candles, just ensure bounds
      hiV = Math.max(hiV, fibLevels.swingHigh);
      loV = Math.min(loV, fibLevels.swingLow);
      // Always include extension (-27% TP) — it's only 27% below swingLow
      loV = Math.min(loV, fibLevels.extensionNeg27);
    }
    const pad = (hiV - loV) * 0.05;
    return { lo: loV - pad, hi: hiV + pad };
  }, [visibleCandles, currentPrice, fibLevels]);

  const plotW = chartW - RIGHT_W;
  const plotH = CHART_HEIGHT - TOP_PAD - BOT_PAD;
  const candleW = visibleCandles.length > 0 ? plotW / visibleCandles.length : 10;
  const bodyW = Math.max(2, candleW * 0.65);

  function emaPath(series: number[]): string {
    if (series.length === 0) return "";
    let d = "";
    let started = false;
    const step = plotW / series.length;
    for (let i = 0; i < series.length; i++) {
      const v = series[i];
      if (isNaN(v)) { started = false; continue; }
      const x = i * step + step / 2;
      const y = priceToY(v, lo, hi, plotH);
      d += started ? `L${x.toFixed(1)},${y.toFixed(1)} ` : `M${x.toFixed(1)},${y.toFixed(1)} `;
      started = true;
    }
    return d;
  }

  // Zone (61.8%–78.6%) highlight — clamped to visible area
  const zoneA = fibLevels ? priceToY(fibLevels.level618, lo, hi, plotH) : null;
  const zoneB = fibLevels ? priceToY(fibLevels.level786, lo, hi, plotH) : null;
  const zoneYTop = zoneA !== null && zoneB !== null ? Math.max(TOP_PAD, Math.min(zoneA, zoneB)) : null;
  const zoneYBot = zoneA !== null && zoneB !== null ? Math.min(TOP_PAD + plotH, Math.max(zoneA, zoneB)) : null;
  const zoneH = zoneYTop !== null && zoneYBot !== null ? Math.max(0, zoneYBot - zoneYTop) : 0;

  const isBull = trend === "Bullish";
  const isBear = trend === "Bearish";
  const trendLabel =
    isBull ? "M15 BULLISH ▲" :
    isBear ? "M15 BEARISH ▼" :
    trend === "Loading" ? `LOADING ${m15Candles.length}/300` : "NO TREND";
  const trendColor = isBull ? C.green : isBear ? C.red : C.textDim;
  const hasNoData = candles.length === 0 && m15Candles.length === 0;

  const SWING_COLOR = "#C084FC";
  const ZONE618_COLOR = "#F0B429";
  const ZONE786_COLOR = "#F97316";
  const SL_COLOR = "#EF4444";
  const TP_COLOR = "#22C55E";

  return (
    <View style={styles.wrapper} onLayout={(e) => setChartW(e.nativeEvent.layout.width)}>
      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.headerTitle}>XAUUSD · Fibonacci Analysis</Text>
          <Text style={styles.headerSub}>
            {selectedTF === "M15" ? "Struktur M15 · Deep Pullback Continuation" : "Eksekusi M5 · Precision Entry"}
          </Text>
        </View>
        <View style={[styles.trendPill, { borderColor: trendColor + "50", backgroundColor: trendColor + "15" }]}>
          <Text style={[styles.trendPillText, { color: trendColor }]}>{trendLabel}</Text>
        </View>
      </View>

      {/* Timeframe Selector */}
      <View style={styles.tfRow}>
        {(["M15", "M5"] as TF[]).map((tf) => (
          <TouchableOpacity
            key={tf}
            style={[styles.tfBtn, selectedTF === tf && styles.tfBtnActive]}
            onPress={() => setSelectedTF(tf)}
            activeOpacity={0.7}
          >
            <Text style={[styles.tfBtnText, selectedTF === tf && styles.tfBtnTextActive]}>
              {tf === "M15" ? "M15 · Struktur" : "M5 · Entry"}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Info Row */}
      <View style={styles.infoRow}>
        <Text style={styles.infoText}>M15: {m15Candles.length} · M5: {candles.length} candle</Text>
        <View style={styles.infoRight}>
          {atr !== null && <Text style={[styles.infoText, styles.atrBadge]}>ATR(14): {atr.toFixed(2)}</Text>}
          {fibLevels && (
            <Text style={styles.infoText}>
              Zona: {Math.min(fibLevels.level618, fibLevels.level786).toFixed(1)}–{Math.max(fibLevels.level618, fibLevels.level786).toFixed(1)}
            </Text>
          )}
        </View>
      </View>

      {chartW > 0 && (
        <Svg width={chartW} height={CHART_HEIGHT}>
          <Defs>
            <LinearGradient id="buyZone" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={C.gold} stopOpacity={0.25} />
              <Stop offset="1" stopColor={C.gold} stopOpacity={0.06} />
            </LinearGradient>
            <LinearGradient id="sellZone" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={C.red} stopOpacity={0.06} />
              <Stop offset="1" stopColor={C.red} stopOpacity={0.25} />
            </LinearGradient>
          </Defs>

          {/* Grid lines */}
          {[0.1, 0.25, 0.4, 0.55, 0.7, 0.85].map((pct, i) => {
            const price = lo + (hi - lo) * (1 - pct);
            const y = priceToY(price, lo, hi, plotH);
            return (
              <G key={i}>
                <Line x1={0} y1={y} x2={plotW} y2={y} stroke={C.border} strokeWidth={0.8} opacity={0.18} />
                <SvgText x={plotW + 2} y={y + 3} fill={C.textDim} fontSize={6.5}>{price.toFixed(0)}</SvgText>
              </G>
            );
          })}

          {/* Fibonacci zone highlight (61.8%–78.6%) — visible portion only */}
          {fibLevels && zoneYTop !== null && zoneYBot !== null && zoneH > 0 && (
            <G>
              <Rect
                x={0}
                y={zoneYTop}
                width={plotW}
                height={zoneH}
                fill={isBull ? "url(#buyZone)" : "url(#sellZone)"}
              />
              <Line x1={0} y1={zoneYTop} x2={0} y2={zoneYBot} stroke={isBull ? C.gold : C.red} strokeWidth={2.5} opacity={0.6} />
              {zoneH > 16 && (
                <G>
                  <Rect
                    x={plotW / 2 - 72}
                    y={(zoneYTop + zoneYBot) / 2 - 9}
                    width={144}
                    height={17}
                    fill="#0A0E17"
                    opacity={0.75}
                    rx={4}
                  />
                  <SvgText
                    x={plotW / 2}
                    y={(zoneYTop + zoneYBot) / 2 + 4}
                    fill={isBull ? C.green : C.red}
                    fontSize={9.5}
                    fontWeight="bold"
                    textAnchor="middle"
                  >
                    {isBull ? "▲ BUY ZONE (M15 Structure)" : "▼ SELL ZONE (M15 Structure)"}
                  </SvgText>
                </G>
              )}
            </G>
          )}

          {/* EMA Lines — M15 view */}
          {selectedTF === "M15" && ema200Series.length > 0 && (
            <Path d={emaPath(ema200Series)} stroke="#F97316" strokeWidth={1.5} fill="none" opacity={0.85} />
          )}
          {selectedTF === "M15" && ema50Series.length > 0 && (
            <Path d={emaPath(ema50Series)} stroke="#A78BFA" strokeWidth={1.5} fill="none" opacity={0.85} />
          )}

          {/* EMA reference lines on M5 view */}
          {selectedTF === "M5" && m15Ema200Val !== null && (
            <FibLine pct="EMA200" desc="M15" price={m15Ema200Val} color="#F97316" lo={lo} hi={hi} plotH={plotH} plotW={plotW} dashed strokeWidth={1.5} />
          )}
          {selectedTF === "M5" && m15Ema50Val !== null && (
            <FibLine pct="EMA50" desc="M15" price={m15Ema50Val} color="#A78BFA" lo={lo} hi={hi} plotH={plotH} plotW={plotW} dashed strokeWidth={1.5} />
          )}

          {/* ── Fibonacci Structure Lines ── */}
          {fibLevels && (() => {
            const trendUp = trend === "Bullish";
            return (
              <>
                <FibLine
                  pct={trendUp ? "0.0%" : "100%"}
                  desc={trendUp ? "Swing High (Support)" : "Swing High (SL Ref)"}
                  price={fibLevels.swingHigh}
                  color={trendUp ? SWING_COLOR : SL_COLOR}
                  lo={lo} hi={hi} plotH={plotH} plotW={plotW}
                  dashed={false} strokeWidth={2.5}
                />
                <FibLine
                  pct="78.6%"
                  desc="Deep Retracement"
                  price={fibLevels.level786}
                  color={ZONE786_COLOR}
                  lo={lo} hi={hi} plotH={plotH} plotW={plotW}
                  dashed strokeWidth={1.8}
                />
                <FibLine
                  pct="61.8%"
                  desc="Golden Retracement"
                  price={fibLevels.level618}
                  color={ZONE618_COLOR}
                  lo={lo} hi={hi} plotH={plotH} plotW={plotW}
                  dashed strokeWidth={1.8}
                />
                <FibLine
                  pct={trendUp ? "100%" : "0.0%"}
                  desc={trendUp ? "Swing Low (SL Ref)" : "Swing Low (Support)"}
                  price={fibLevels.swingLow}
                  color={trendUp ? SL_COLOR : SWING_COLOR}
                  lo={lo} hi={hi} plotH={plotH} plotW={plotW}
                  dashed={false} strokeWidth={2.5}
                />
                <FibLine
                  pct="-27%"
                  desc="Extension (Take Profit)"
                  price={fibLevels.extensionNeg27}
                  color={TP_COLOR}
                  lo={lo} hi={hi} plotH={plotH} plotW={plotW}
                  dashed strokeWidth={2}
                />
              </>
            );
          })()}

          {/* ── Candlesticks ── */}
          {visibleCandles.map((c, i) => {
            const isBullCandle = c.close >= c.open;
            const col = isBullCandle ? C.green : C.red;
            const cx = i * candleW + candleW / 2;
            const bTop = priceToY(Math.max(c.open, c.close), lo, hi, plotH);
            const bBot = priceToY(Math.min(c.open, c.close), lo, hi, plotH);
            const wTop = priceToY(c.high, lo, hi, plotH);
            const wBot = priceToY(c.low, lo, hi, plotH);
            const bh = Math.max(1.5, bBot - bTop);
            return (
              <G key={c.epoch}>
                <Line x1={cx} y1={wTop} x2={cx} y2={wBot} stroke={col} strokeWidth={1.2} opacity={0.85} />
                <Rect
                  x={cx - bodyW / 2}
                  y={bTop}
                  width={bodyW}
                  height={bh}
                  fill={col}
                  opacity={isBullCandle ? 0.92 : 0.85}
                  rx={0.5}
                />
              </G>
            );
          })}

          {/* ── Signal badge (BUY / SELL) on candle ── */}
          {currentSignal && (() => {
            const idx = visibleCandles.findIndex((c) => c.epoch === currentSignal.signalCandleEpoch);
            const signalIsBull = currentSignal.trend === "Bullish";
            const col = signalIsBull ? C.green : C.red;
            const badgeLabel = signalIsBull ? "▲ BUY" : "▼ SELL";
            const confirmLabel = currentSignal.confirmationType === "rejection" ? "Pin Bar" : "Engulfing";
            const cx = idx >= 0 ? idx * candleW + candleW / 2 : plotW * 0.8;
            const refCandle = idx >= 0 ? visibleCandles[idx] : null;
            const bW = 68;
            const bH = 28;
            const lx = Math.min(Math.max(cx - bW / 2, 2), plotW - bW - 4);

            if (signalIsBull) {
              const tipY = refCandle ? priceToY(refCandle.high, lo, hi, plotH) - 4 : priceToY(currentSignal.entryPrice, lo, hi, plotH) - 4;
              const labelY = Math.max(TOP_PAD + 2, tipY - bH - 6);
              return (
                <G>
                  <Line x1={cx} y1={tipY} x2={cx} y2={labelY + bH} stroke={col} strokeWidth={1} opacity={0.7} />
                  <Polygon points={`${cx - 5},${tipY} ${cx + 5},${tipY} ${cx},${tipY - 6}`} fill={col} />
                  <Rect x={lx} y={labelY} width={bW} height={bH} fill={col} rx={4} />
                  <SvgText x={lx + bW / 2} y={labelY + 12} fill="#fff" fontSize={10} fontWeight="bold" textAnchor="middle">{badgeLabel}</SvgText>
                  <SvgText x={lx + bW / 2} y={labelY + 23} fill="#fff" fontSize={7} textAnchor="middle" opacity={0.9}>{confirmLabel}</SvgText>
                </G>
              );
            } else {
              const tipY = refCandle ? priceToY(refCandle.low, lo, hi, plotH) + 4 : priceToY(currentSignal.entryPrice, lo, hi, plotH) + 4;
              const labelY = Math.min(tipY + 6, TOP_PAD + plotH - bH - 2);
              return (
                <G>
                  <Line x1={cx} y1={tipY} x2={cx} y2={labelY} stroke={col} strokeWidth={1} opacity={0.7} />
                  <Polygon points={`${cx - 5},${tipY} ${cx + 5},${tipY} ${cx},${tipY + 6}`} fill={col} />
                  <Rect x={lx} y={labelY} width={bW} height={bH} fill={col} rx={4} />
                  <SvgText x={lx + bW / 2} y={labelY + 12} fill="#fff" fontSize={10} fontWeight="bold" textAnchor="middle">{badgeLabel}</SvgText>
                  <SvgText x={lx + bW / 2} y={labelY + 23} fill="#fff" fontSize={7} textAnchor="middle" opacity={0.9}>{confirmLabel}</SvgText>
                </G>
              );
            }
          })()}

          {/* ── Signal levels (Entry / SL / TP) ── */}
          {currentSignal && (
            <>
              <FibLine
                pct="ENTRY"
                desc={currentSignal.trend === "Bullish" ? "BUY" : "SELL"}
                price={currentSignal.entryPrice}
                color="#FACC15"
                lo={lo} hi={hi} plotH={plotH} plotW={plotW}
                dashed={false} strokeWidth={2.5}
              />
              <FibLine
                pct="SL"
                desc="Stop Loss"
                price={currentSignal.stopLoss}
                color="#EF4444"
                lo={lo} hi={hi} plotH={plotH} plotW={plotW}
                dashed strokeWidth={2}
              />
              <FibLine
                pct="TP"
                desc="Take Profit"
                price={currentSignal.takeProfit}
                color="#22C55E"
                lo={lo} hi={hi} plotH={plotH} plotW={plotW}
                dashed strokeWidth={2}
              />
            </>
          )}

          {/* ── Live price ticker ── */}
          {currentPrice !== null && (() => {
            const y = priceToY(currentPrice, lo, hi, plotH);
            const lastC = visibleCandles[visibleCandles.length - 1];
            const priceUp = !lastC || currentPrice >= lastC.open;
            const lc = priceUp ? C.green : C.red;
            return (
              <G>
                <Path d={dashedPath(0, y, plotW, 3, 3)} stroke={lc} strokeWidth={1} opacity={0.4} />
                <Polygon points={`${plotW},${y - 5} ${plotW + 6},${y} ${plotW},${y + 5}`} fill={lc} />
                <Rect x={plotW + 6} y={y - 10} width={RIGHT_W - 8} height={20} fill={lc} rx={3} />
                <SvgText x={plotW + 9} y={y + 4} fill="#fff" fontSize={9} fontWeight="bold">
                  {currentPrice.toFixed(2)}
                </SvgText>
              </G>
            );
          })()}
        </Svg>
      )}

      {/* Legend */}
      <View style={styles.legend}>
        <LegItem color={SWING_COLOR} label="Swing" line />
        <LegItem color={ZONE618_COLOR} label="61.8%" box />
        <LegItem color={ZONE786_COLOR} label="78.6%" box />
        <LegItem color={TP_COLOR} label="TP" />
        <LegItem color={SL_COLOR} label="SL" />
        <LegItem color="#A78BFA" label="EMA50" line />
        <LegItem color="#F97316" label="EMA200" line />
      </View>

      {/* Real-time PnL Panel */}
      {activeSignal && currentPrice !== null && (() => {
        const pnl = calcFloatingPnL(activeSignal.trend, activeSignal.entryPrice, currentPrice);
        const isProfit = pnl >= 0;
        const isBullSig = activeSignal.trend === "Bullish";
        const dirColor = isBullSig ? C.green : C.red;
        const pnlColor = isProfit ? C.green : C.red;
        const priceDiff = isBullSig
          ? currentPrice - activeSignal.entryPrice
          : activeSignal.entryPrice - currentPrice;
        return (
          <View style={[styles.pnlPanel, { borderColor: pnlColor + "50", backgroundColor: pnlColor + "12" }]}>
            <View style={styles.pnlLeft}>
              <View style={[styles.pnlBadge, { backgroundColor: dirColor }]}>
                <Text style={styles.pnlBadgeText}>{isBullSig ? "▲ BUY" : "▼ SELL"}</Text>
              </View>
              <View style={styles.pnlPriceCol}>
                <Text style={styles.pnlPriceLabel}>Entry</Text>
                <Text style={[styles.pnlPriceVal, { color: dirColor }]}>{activeSignal.entryPrice.toFixed(2)}</Text>
              </View>
              <View style={styles.pnlPriceCol}>
                <Text style={styles.pnlPriceLabel}>Now</Text>
                <Text style={styles.pnlPriceVal}>{currentPrice.toFixed(2)}</Text>
              </View>
              <View style={styles.pnlPriceCol}>
                <Text style={styles.pnlPriceLabel}>Δ Pts</Text>
                <Text style={[styles.pnlPriceVal, { color: pnlColor }]}>
                  {priceDiff >= 0 ? "+" : ""}{priceDiff.toFixed(2)}
                </Text>
              </View>
            </View>
            <View style={styles.pnlRight}>
              <Text style={styles.pnlLabel}>PnL · 0.01 lot</Text>
              <Text style={[styles.pnlValue, { color: pnlColor }]}>{isProfit ? "+" : ""}${pnl.toFixed(2)}</Text>
              <Text style={[styles.pnlStatus, { color: pnlColor }]}>{isProfit ? "● PROFIT" : "● LOSS"}</Text>
            </View>
          </View>
        );
      })()}

      {hasNoData && (
        <View style={styles.overlay}>
          <Text style={styles.overlayText}>Menghubungkan ke Deriv WebSocket...</Text>
          <Text style={[styles.overlayText, { fontSize: 10, marginTop: 4, opacity: 0.6 }]}>
            Memuat data candle M15 dan M5...
          </Text>
        </View>
      )}
    </View>
  );
}

function LegItem({ color, label, line = false, box = false }: { color: string; label: string; line?: boolean; box?: boolean }) {
  return (
    <View style={styles.legItem}>
      {box ? (
        <View style={[styles.legBox, { backgroundColor: color + "40", borderColor: color }]} />
      ) : line ? (
        <View style={[styles.legLine, { backgroundColor: color }]} />
      ) : (
        <View style={[styles.legDot, { backgroundColor: color }]} />
      )}
      <Text style={styles.legText}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    width: "100%",
    alignSelf: "stretch",
    backgroundColor: C.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: C.border,
    marginBottom: 12,
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 8,
    gap: 8,
  },
  headerTitle: {
    fontFamily: "Inter_700Bold",
    fontSize: 13,
    color: C.text,
    letterSpacing: 0.3,
  },
  headerSub: {
    fontFamily: "Inter_400Regular",
    fontSize: 10,
    color: C.textDim,
    marginTop: 2,
  },
  trendPill: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 20,
    borderWidth: 1,
    alignSelf: "flex-start",
  },
  trendPillText: {
    fontFamily: "Inter_700Bold",
    fontSize: 10,
    letterSpacing: 0.5,
  },
  tfRow: {
    flexDirection: "row",
    paddingHorizontal: 12,
    paddingBottom: 6,
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  tfBtn: {
    paddingHorizontal: 14,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: "transparent",
  },
  tfBtnActive: {
    backgroundColor: C.gold + "20",
    borderColor: C.gold,
  },
  tfBtnText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 11,
    color: C.textDim,
  },
  tfBtnTextActive: {
    color: C.gold,
  },
  infoRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  infoRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  infoText: {
    fontFamily: "Inter_400Regular",
    fontSize: 9.5,
    color: C.textDim,
  },
  atrBadge: {
    color: "#A78BFA",
    fontFamily: "Inter_600SemiBold",
  },
  legend: {
    flexDirection: "row",
    flexWrap: "wrap",
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 10,
    borderTopWidth: 1,
    borderTopColor: C.border,
  },
  legItem: { flexDirection: "row", alignItems: "center", gap: 4 },
  legDot: { width: 6, height: 6, borderRadius: 3 },
  legLine: { width: 14, height: 2, borderRadius: 1 },
  legBox: { width: 10, height: 8, borderRadius: 2, borderWidth: 1 },
  legText: { fontFamily: "Inter_400Regular", fontSize: 9, color: C.textDim },
  overlay: {
    position: "absolute",
    top: 80,
    left: 0,
    right: 0,
    bottom: 32,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: C.card + "D0",
  },
  overlayText: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    color: C.textSub,
    textAlign: "center",
    paddingHorizontal: 20,
  },
  pnlPanel: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginHorizontal: 12,
    marginBottom: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
  },
  pnlLeft: { flexDirection: "row", alignItems: "center", gap: 10, flex: 1 },
  pnlBadge: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 },
  pnlBadgeText: { fontFamily: "Inter_700Bold", fontSize: 11, color: "#fff", letterSpacing: 0.4 },
  pnlPriceCol: { alignItems: "center" },
  pnlPriceLabel: { fontFamily: "Inter_400Regular", fontSize: 8, color: C.textDim, marginBottom: 1 },
  pnlPriceVal: { fontFamily: "Inter_700Bold", fontSize: 10, color: C.text },
  pnlRight: { alignItems: "flex-end" },
  pnlLabel: { fontFamily: "Inter_400Regular", fontSize: 8, color: C.textDim },
  pnlValue: { fontFamily: "Inter_700Bold", fontSize: 16 },
  pnlStatus: { fontFamily: "Inter_600SemiBold", fontSize: 8, marginTop: 1 },
});
