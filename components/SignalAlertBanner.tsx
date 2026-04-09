import React, { useEffect, useRef, useState } from "react";
import {
  Animated,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import C from "@/constants/colors";
import { useTrading, TradingSignal } from "@/contexts/TradingContext";

interface AlertData {
  signal: TradingSignal;
  id: string;
}

// Sinyal dianggap "fresh" kalau muncul kurang dari 15 menit yang lalu
function isSignalFresh(signal: TradingSignal): boolean {
  // timestamp format: "Jum, 7 Mar 2026 18:35:00 WIB" — parse secara sederhana
  // Cukup cek bahwa signal bukan dari cache lama: gunakan signalCandleEpoch jika tersedia
  // signalCandleEpoch dalam detik (unix)
  const now = Date.now() / 1000;
  const age = now - signal.signalCandleEpoch;
  return age < 15 * 60; // 15 menit
}

export function SignalAlertBanner() {
  const { currentSignal, activeSignal } = useTrading();
  const [alert, setAlert] = useState<AlertData | null>(null);
  const slideAnim = useRef(new Animated.Value(-120)).current;
  const opacityAnim = useRef(new Animated.Value(0)).current;
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastShownId = useRef<string | null>(null);

  // Gunakan currentSignal (real-time) atau activeSignal (server-synced fresh)
  const signalToShow = currentSignal ?? (activeSignal && isSignalFresh(activeSignal) ? activeSignal : null);

  useEffect(() => {
    if (!signalToShow) return;
    if (signalToShow.id === lastShownId.current) return;
    lastShownId.current = signalToShow.id;

    setAlert({ signal: signalToShow, id: signalToShow.id });

    // Slide in
    Animated.parallel([
      Animated.spring(slideAnim, {
        toValue: 0,
        useNativeDriver: Platform.OS !== "web",
        tension: 60,
        friction: 10,
      }),
      Animated.timing(opacityAnim, {
        toValue: 1,
        duration: 300,
        useNativeDriver: Platform.OS !== "web",
      }),
    ]).start();

    // Auto dismiss setelah 8 detik
    if (dismissTimer.current) clearTimeout(dismissTimer.current);
    dismissTimer.current = setTimeout(() => dismiss(), 8000);

    return () => {
      if (dismissTimer.current) clearTimeout(dismissTimer.current);
    };
  }, [signalToShow?.id]);

  const dismiss = () => {
    Animated.parallel([
      Animated.timing(slideAnim, {
        toValue: -120,
        duration: 250,
        useNativeDriver: Platform.OS !== "web",
      }),
      Animated.timing(opacityAnim, {
        toValue: 0,
        duration: 250,
        useNativeDriver: Platform.OS !== "web",
      }),
    ]).start(() => setAlert(null));
  };

  if (!alert) return null;

  const isBull = alert.signal.trend === "Bullish";
  const trendColor = isBull ? C.green : C.red;
  const bgColor = isBull ? "rgba(16,185,129,0.12)" : "rgba(239,68,68,0.12)";

  return (
    <Animated.View
      style={[
        styles.container,
        {
          transform: [{ translateY: slideAnim }],
          opacity: opacityAnim,
          backgroundColor: bgColor,
          borderColor: trendColor + "60",
        },
      ]}
    >
      <View style={styles.iconCol}>
        <View style={[styles.iconCircle, { backgroundColor: trendColor + "25" }]}>
          <Ionicons
            name={isBull ? "trending-up" : "trending-down"}
            size={20}
            color={trendColor}
          />
        </View>
      </View>

      <View style={styles.content}>
        <View style={styles.titleRow}>
          <View style={[styles.pulseDot, { backgroundColor: trendColor }]} />
          <Text style={[styles.alertTitle, { color: trendColor }]}>
            SINYAL {isBull ? "BUY ▲" : "SELL ▼"} — XAUUSD
          </Text>
        </View>
        <View style={styles.priceRow}>
          <Text style={styles.priceLabel}>Entry</Text>
          <Text style={[styles.priceValue, { color: trendColor }]}>
            {alert.signal.entryPrice.toFixed(2)}
          </Text>
          <Text style={styles.priceSep}>·</Text>
          <Text style={styles.priceLabel}>SL</Text>
          <Text style={[styles.priceValue, { color: C.red }]}>
            {alert.signal.stopLoss.toFixed(2)}
          </Text>
          <Text style={styles.priceSep}>·</Text>
          <Text style={styles.priceLabel}>TP1</Text>
          <Text style={[styles.priceValue, { color: C.green }]}>
            {alert.signal.takeProfit.toFixed(2)}
          </Text>
        </View>
        <Text style={styles.subText}>
          {alert.signal.confirmationType === "engulfing" ? "Engulfing M5" : "Rejection M5"} · R:R 1:{alert.signal.riskReward}
          {alert.signal.marketRegime ? ` · ${alert.signal.marketRegime.toUpperCase()}` : ""}
        </Text>
      </View>

      <Pressable onPress={dismiss} style={styles.closeBtn} hitSlop={12}>
        <Ionicons name="close" size={16} color={C.textSub} />
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginHorizontal: 12,
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    gap: 10,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 10,
    elevation: 10,
  },
  iconCol: {
    alignItems: "center",
    justifyContent: "center",
  },
  iconCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  content: {
    flex: 1,
    gap: 3,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  pulseDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  alertTitle: {
    fontFamily: "Inter_700Bold",
    fontSize: 13,
    letterSpacing: 0.5,
  },
  priceRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  priceLabel: {
    fontFamily: "Inter_500Medium",
    fontSize: 10,
    color: C.textDim,
    letterSpacing: 0.8,
  },
  priceValue: {
    fontFamily: "Inter_700Bold",
    fontSize: 12,
  },
  priceSep: {
    color: C.textDim,
    fontSize: 10,
  },
  subText: {
    fontFamily: "Inter_400Regular",
    fontSize: 10,
    color: C.textSub,
    letterSpacing: 0.3,
  },
  closeBtn: {
    padding: 4,
    alignSelf: "flex-start",
  },
});
