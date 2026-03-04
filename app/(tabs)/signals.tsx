import React from "react";
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  Platform,
  Pressable,
  Alert,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import C from "@/constants/colors";
import { useTrading, TradingSignal } from "@/contexts/TradingContext";

function OutcomeBadge({ outcome }: { outcome?: "win" | "loss" | "pending" }) {
  if (!outcome || outcome === "pending") {
    return (
      <View style={[outcomeBadgeStyles.badge, { backgroundColor: "rgba(59,130,246,0.15)" }]}>
        <View style={[outcomeBadgeStyles.dot, { backgroundColor: C.blue }]} />
        <Text style={[outcomeBadgeStyles.text, { color: C.blue }]}>PENDING</Text>
      </View>
    );
  }
  if (outcome === "win") {
    return (
      <View style={[outcomeBadgeStyles.badge, { backgroundColor: "rgba(16,185,129,0.15)" }]}>
        <Ionicons name="checkmark-circle" size={11} color={C.green} />
        <Text style={[outcomeBadgeStyles.text, { color: C.green }]}>WIN</Text>
      </View>
    );
  }
  return (
    <View style={[outcomeBadgeStyles.badge, { backgroundColor: "rgba(239,68,68,0.15)" }]}>
      <Ionicons name="close-circle" size={11} color={C.red} />
      <Text style={[outcomeBadgeStyles.text, { color: C.red }]}>LOSS</Text>
    </View>
  );
}

const outcomeBadgeStyles = StyleSheet.create({
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 20,
    alignSelf: "flex-start",
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  text: {
    fontFamily: "Inter_700Bold",
    fontSize: 9,
    letterSpacing: 1.2,
  },
});

function WinRateCard({ signals }: { signals: TradingSignal[] }) {
  const closed = signals.filter((s) => s.outcome === "win" || s.outcome === "loss");
  const wins = signals.filter((s) => s.outcome === "win").length;
  const losses = signals.filter((s) => s.outcome === "loss").length;
  const pending = signals.filter((s) => !s.outcome || s.outcome === "pending").length;
  const winRate = closed.length > 0 ? Math.round((wins / closed.length) * 100) : null;

  const rateColor =
    winRate === null ? C.textSub :
    winRate >= 60 ? C.green :
    winRate >= 45 ? C.gold :
    C.red;

  return (
    <View style={wrStyles.card}>
      <View style={wrStyles.winRateRow}>
        <View style={wrStyles.winRateMain}>
          <Text style={wrStyles.wrLabel}>WIN RATE</Text>
          {winRate !== null ? (
            <Text style={[wrStyles.wrValue, { color: rateColor }]}>{winRate}%</Text>
          ) : (
            <Text style={[wrStyles.wrValue, { color: C.textDim }]}>—</Text>
          )}
        </View>
        <View style={wrStyles.divider} />
        <View style={wrStyles.statBlock}>
          <Text style={wrStyles.statNumber}>{signals.length}</Text>
          <Text style={wrStyles.statLabel}>TOTAL</Text>
        </View>
        <View style={wrStyles.statBlock}>
          <Text style={[wrStyles.statNumber, { color: C.green }]}>{wins}</Text>
          <Text style={wrStyles.statLabel}>WIN</Text>
        </View>
        <View style={wrStyles.statBlock}>
          <Text style={[wrStyles.statNumber, { color: C.red }]}>{losses}</Text>
          <Text style={wrStyles.statLabel}>LOSS</Text>
        </View>
        <View style={wrStyles.statBlock}>
          <Text style={[wrStyles.statNumber, { color: C.blue }]}>{pending}</Text>
          <Text style={wrStyles.statLabel}>OPEN</Text>
        </View>
      </View>

      {closed.length > 0 && (
        <View style={wrStyles.barContainer}>
          <View style={wrStyles.barTrack}>
            {wins > 0 && (
              <View
                style={[
                  wrStyles.barFill,
                  {
                    flex: wins,
                    backgroundColor: C.green,
                    borderTopLeftRadius: 4,
                    borderBottomLeftRadius: 4,
                    borderTopRightRadius: losses === 0 ? 4 : 0,
                    borderBottomRightRadius: losses === 0 ? 4 : 0,
                  },
                ]}
              />
            )}
            {losses > 0 && (
              <View
                style={[
                  wrStyles.barFill,
                  {
                    flex: losses,
                    backgroundColor: C.red,
                    borderTopRightRadius: 4,
                    borderBottomRightRadius: 4,
                    borderTopLeftRadius: wins === 0 ? 4 : 0,
                    borderBottomLeftRadius: wins === 0 ? 4 : 0,
                  },
                ]}
              />
            )}
          </View>
        </View>
      )}
    </View>
  );
}

const wrStyles = StyleSheet.create({
  card: {
    backgroundColor: C.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: C.border,
    padding: 16,
    marginHorizontal: 16,
    marginBottom: 12,
    gap: 12,
  },
  winRateRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 0,
  },
  winRateMain: {
    flex: 1.5,
    alignItems: "flex-start",
    gap: 2,
  },
  wrLabel: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 9,
    color: C.textDim,
    letterSpacing: 1.5,
  },
  wrValue: {
    fontFamily: "Orbitron_800ExtraBold",
    fontSize: 30,
    letterSpacing: -1,
    lineHeight: 36,
  },
  divider: {
    width: 1,
    height: 40,
    backgroundColor: C.border,
    marginHorizontal: 12,
  },
  statBlock: {
    flex: 1,
    alignItems: "center",
    gap: 3,
  },
  statNumber: {
    fontFamily: "Orbitron_700Bold",
    fontSize: 18,
    color: C.text,
    lineHeight: 22,
  },
  statLabel: {
    fontFamily: "Inter_500Medium",
    fontSize: 8,
    color: C.textDim,
    letterSpacing: 1.2,
  },
  barContainer: {
    gap: 4,
  },
  barTrack: {
    flexDirection: "row",
    height: 6,
    borderRadius: 4,
    overflow: "hidden",
    backgroundColor: C.border,
  },
  barFill: {
    height: 6,
  },
});

function SignalItem({ signal }: { signal: TradingSignal }) {
  const isBull = signal.trend === "Bullish";
  const trendColor = isBull ? C.green : C.red;

  return (
    <View
      style={[
        styles.signalItem,
        { borderLeftColor: trendColor },
        signal.outcome === "win" && { borderColor: "rgba(16,185,129,0.25)" },
        signal.outcome === "loss" && { borderColor: "rgba(239,68,68,0.20)" },
      ]}
    >
      <View style={styles.signalTop}>
        <View style={styles.signalLeft}>
          <View style={styles.pillsRow}>
            <View style={[styles.trendPill, { backgroundColor: trendColor + "20" }]}>
              <Ionicons
                name={isBull ? "trending-up" : "trending-down"}
                size={12}
                color={trendColor}
              />
              <Text style={[styles.trendPillText, { color: trendColor }]}>
                {signal.trend.toUpperCase()}
              </Text>
            </View>
            <View style={[styles.confirmPill, { backgroundColor: trendColor + "15" }]}>
              <Ionicons
                name={signal.confirmationType === "engulfing" ? "layers" : "radio-button-on"}
                size={10}
                color={trendColor}
              />
              <Text style={[styles.confirmPillText, { color: trendColor }]}>
                {signal.confirmationType === "engulfing" ? "ENGULFING" : "REJECTION"}
              </Text>
            </View>
            <OutcomeBadge outcome={signal.outcome} />
          </View>
          <Text style={styles.pairText}>{signal.pair} · {signal.timeframe}</Text>
        </View>
        <View style={styles.rrContainer}>
          <Text style={styles.rrSmallLabel}>R:R</Text>
          <Text style={styles.rrSmallValue}>1:{signal.riskReward}</Text>
        </View>
      </View>

      <View style={styles.signalPrices}>
        <View style={styles.priceBlock}>
          <Text style={styles.priceBlockLabel}>ENTRY</Text>
          <Text style={[styles.priceBlockValue, { color: trendColor }]}>
            {signal.entryPrice.toFixed(2)}
          </Text>
        </View>
        <View style={styles.priceDivider} />
        <View style={styles.priceBlock}>
          <Text style={styles.priceBlockLabel}>SL</Text>
          <Text style={[styles.priceBlockValue, { color: C.red }]}>
            {signal.stopLoss.toFixed(2)}
          </Text>
        </View>
        <View style={styles.priceDivider} />
        <View style={styles.priceBlock}>
          <Text style={styles.priceBlockLabel}>TP</Text>
          <Text style={[styles.priceBlockValue, { color: C.green }]}>
            {signal.takeProfit.toFixed(2)}
          </Text>
        </View>
        <View style={styles.priceDivider} />
        <View style={styles.priceBlock}>
          <Text style={styles.priceBlockLabel}>LOT</Text>
          <Text style={[styles.priceBlockValue, { color: C.blue }]}>
            {signal.lotSize.toFixed(2)}
          </Text>
        </View>
      </View>

      <Text style={styles.signalTime}>{signal.timestampUTC}</Text>
    </View>
  );
}

export default function SignalsScreen() {
  const insets = useSafeAreaInsets();
  const topPad = Platform.OS === "web" ? 67 : insets.top;
  const botPad = Platform.OS === "web" ? 84 : insets.bottom + 60;
  const { signalHistory, clearHistory } = useTrading();

  const handleClear = () => {
    if (Platform.OS !== "web") {
      Alert.alert(
        "Hapus History",
        "Hapus semua riwayat sinyal?",
        [
          { text: "Batal", style: "cancel" },
          {
            text: "Hapus",
            style: "destructive",
            onPress: () => {
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
              clearHistory();
            },
          },
        ]
      );
    } else {
      clearHistory();
    }
  };

  return (
    <View style={[styles.container, { paddingTop: topPad }]}>
      <View style={styles.header}>
        <View>
          <Text style={styles.headerTitle}>Signal History</Text>
          <Text style={styles.headerSub}>{signalHistory.length} sinyal tercatat</Text>
        </View>
        {signalHistory.length > 0 && (
          <Pressable
            onPress={handleClear}
            style={({ pressed }) => [
              styles.clearBtn,
              { opacity: pressed ? 0.6 : 1 },
            ]}
          >
            <Ionicons name="trash-outline" size={18} color={C.red} />
          </Pressable>
        )}
      </View>

      <FlatList
        data={signalHistory}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <SignalItem signal={item} />}
        ListHeaderComponent={
          signalHistory.length > 0 ? (
            <WinRateCard signals={signalHistory} />
          ) : null
        }
        contentContainerStyle={[
          styles.listContent,
          { paddingBottom: botPad + 16 },
        ]}
        showsVerticalScrollIndicator={false}
        scrollEnabled
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <View style={styles.emptyIcon}>
              <MaterialCommunityIcons
                name="bell-sleep-outline"
                size={40}
                color={C.textDim}
              />
            </View>
            <Text style={styles.emptyTitle}>Belum Ada Sinyal</Text>
            <Text style={styles.emptySub}>
              Sinyal muncul ketika semua kondisi terpenuhi: trend, zona Fibonacci, dan konfirmasi candle.
            </Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 16,
  },
  headerTitle: {
    fontFamily: "Inter_700Bold",
    fontSize: 22,
    color: C.text,
  },
  headerSub: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    color: C.textSub,
    marginTop: 2,
  },
  clearBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: C.redBg,
    justifyContent: "center",
    alignItems: "center",
  },
  listContent: {
    paddingHorizontal: 16,
  },
  signalItem: {
    backgroundColor: C.card,
    borderRadius: 16,
    padding: 16,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: C.border,
    borderLeftWidth: 3,
  },
  signalTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  signalLeft: {
    gap: 4,
    flex: 1,
  },
  pillsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexWrap: "wrap",
  },
  confirmPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 12,
    alignSelf: "flex-start",
  },
  confirmPillText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 9,
    letterSpacing: 0.6,
  },
  trendPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 12,
    alignSelf: "flex-start",
  },
  trendPillText: {
    fontFamily: "Inter_700Bold",
    fontSize: 10,
    letterSpacing: 0.8,
  },
  pairText: {
    fontFamily: "Inter_500Medium",
    fontSize: 12,
    color: C.textSub,
  },
  rrContainer: {
    alignItems: "flex-end",
  },
  rrSmallLabel: {
    fontFamily: "Inter_400Regular",
    fontSize: 10,
    color: C.textDim,
    letterSpacing: 1,
  },
  rrSmallValue: {
    fontFamily: "Inter_700Bold",
    fontSize: 18,
    color: C.gold,
  },
  signalPrices: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  priceBlock: {
    flex: 1,
    alignItems: "center",
    gap: 3,
  },
  priceBlockLabel: {
    fontFamily: "Inter_500Medium",
    fontSize: 9,
    color: C.textDim,
    letterSpacing: 1.2,
  },
  priceBlockValue: {
    fontFamily: "Inter_700Bold",
    fontSize: 13,
  },
  priceDivider: {
    width: 1,
    backgroundColor: C.border,
    marginVertical: 2,
  },
  signalTime: {
    fontFamily: "Inter_400Regular",
    fontSize: 10,
    color: C.textDim,
  },
  emptyState: {
    alignItems: "center",
    paddingTop: 80,
    paddingHorizontal: 40,
    gap: 12,
  },
  emptyIcon: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: C.card,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 8,
  },
  emptyTitle: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 18,
    color: C.textSub,
  },
  emptySub: {
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    color: C.textDim,
    textAlign: "center",
    lineHeight: 20,
  },
});
