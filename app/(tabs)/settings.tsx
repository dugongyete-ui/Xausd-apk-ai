import React, { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Platform,
  Pressable,
  ScrollView,
  Alert,
  Switch,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import C from "@/constants/colors";
import { useTrading } from "@/contexts/TradingContext";

function InfoRow({
  icon,
  label,
  value,
  valueColor,
}: {
  icon: string;
  label: string;
  value: string;
  valueColor?: string;
}) {
  return (
    <View style={styles.infoRow}>
      <View style={styles.infoLeft}>
        <MaterialCommunityIcons name={icon as any} size={18} color={C.gold} />
        <Text style={styles.infoLabel}>{label}</Text>
      </View>
      <Text style={[styles.infoValue, valueColor ? { color: valueColor } : {}]}>
        {value}
      </Text>
    </View>
  );
}

function StrategyRule({ title, detail, isLast }: { title: string; detail: string; isLast?: boolean }) {
  return (
    <View style={[styles.ruleRow, isLast && styles.ruleRowLast]}>
      <View style={styles.ruleDot} />
      <View style={styles.ruleContent}>
        <Text style={styles.ruleTitle}>{title}</Text>
        <Text style={styles.ruleDetail}>{detail}</Text>
      </View>
    </View>
  );
}

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const topPad = Platform.OS === "web" ? 67 : insets.top;
  const botPad = Platform.OS === "web" ? 84 : insets.bottom + 60;
  const { atr, connectionStatus, candles, notificationEnabled, requestNotifications, injectDemoSignal, clearDemoSignal, activeSignal, currentPrice } = useTrading();
  const [demoSent, setDemoSent] = useState<"BUY" | "SELL" | null>(null);

  const handleDemoSignal = (type: "BUY" | "SELL") => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    injectDemoSignal(type);
    setDemoSent(type);
    setTimeout(() => setDemoSent(null), 3000);
  };

  const handleClearDemo = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    clearDemoSignal();
    setDemoSent(null);
  };

  return (
    <View style={[styles.container, { paddingTop: topPad }]}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: botPad + 16 }}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Settings</Text>
          <Text style={styles.headerSub}>Risk Management & Strategy</Text>
        </View>

        {/* ─── Demo Signal Tester ─── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>TEST SINYAL VISUAL</Text>
          <View style={styles.card}>
            <Text style={styles.demoDesc}>
              Tekan tombol di bawah untuk melihat tampilan sinyal BUY atau SELL di dashboard dan halaman Signals. Ini hanya untuk preview — bukan sinyal trading nyata.
            </Text>
            {currentPrice !== null && (
              <Text style={styles.demoPrice}>Harga Live: {currentPrice.toFixed(2)}</Text>
            )}
            <View style={styles.demoRow}>
              <Pressable
                onPress={() => handleDemoSignal("BUY")}
                style={({ pressed }) => [
                  styles.demoBtnBuy,
                  { opacity: pressed ? 0.75 : 1 },
                  demoSent === "BUY" && styles.demoBtnActive,
                ]}
              >
                <Ionicons name="trending-up" size={18} color="#fff" />
                <Text style={styles.demoBtnText}>
                  {demoSent === "BUY" ? "Sinyal BUY Aktif!" : "Test BUY"}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => handleDemoSignal("SELL")}
                style={({ pressed }) => [
                  styles.demoBtnSell,
                  { opacity: pressed ? 0.75 : 1 },
                  demoSent === "SELL" && styles.demoBtnActive,
                ]}
              >
                <Ionicons name="trending-down" size={18} color="#fff" />
                <Text style={styles.demoBtnText}>
                  {demoSent === "SELL" ? "Sinyal SELL Aktif!" : "Test SELL"}
                </Text>
              </Pressable>
            </View>
            {activeSignal && activeSignal.id.startsWith("demo-") && (
              <Pressable
                onPress={handleClearDemo}
                style={({ pressed }) => [styles.demoClearBtn, { opacity: pressed ? 0.75 : 1 }]}
              >
                <Ionicons name="close-circle-outline" size={16} color={C.textSub} />
                <Text style={styles.demoClearText}>Hapus Demo Signal</Text>
              </Pressable>
            )}
            <View style={styles.demoNote}>
              <Ionicons name="information-circle-outline" size={14} color={C.textDim} />
              <Text style={styles.demoNoteText}>
                Buka tab Dashboard untuk melihat Signal Card dan tab Signals untuk history.
              </Text>
            </View>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>RISK PARAMETERS</Text>
          <View style={styles.card}>
            <InfoRow
              icon="percent"
              label="Risk per Trade"
              value="1.00%"
              valueColor={C.gold}
            />
            <View style={styles.divider} />
            <InfoRow
              icon="sigma"
              label="ATR (14)"
              value={atr !== null ? atr.toFixed(3) : "—"}
            />
            <View style={styles.divider} />
            <InfoRow
              icon="database"
              label="M5 Candles"
              value={`${candles.length} / 10`}
              valueColor={candles.length >= 10 ? C.green : C.gold}
            />
            <View style={styles.divider} />
            <InfoRow
              icon="wifi"
              label="WebSocket"
              value={
                connectionStatus === "connected"
                  ? "Connected"
                  : connectionStatus === "connecting"
                  ? "Connecting..."
                  : "Disconnected"
              }
              valueColor={
                connectionStatus === "connected"
                  ? C.green
                  : connectionStatus === "connecting"
                  ? C.gold
                  : C.red
              }
            />
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>STRATEGY RULES</Text>
          <View style={styles.card}>
            <StrategyRule
              title="Data Source"
              detail="Deriv WebSocket · XAUUSD · M15: 300 candle struktur · M5: 100 candle konfirmasi"
            />
            <StrategyRule
              title="Trend Filter"
              detail="EMA50 > EMA200 = Bullish · EMA50 < EMA200 = Bearish"
            />
            <StrategyRule
              title="Swing Detection"
              detail="Fractal method: 5-candle fractal (2L + pivot + 2R)"
            />
            <StrategyRule
              title="Entry Zone"
              detail="Price must be within 61.8% — 78.6% Fibonacci band"
            />
            <StrategyRule
              title="Candle Confirmation"
              detail="BUY: Bullish close + lower wick > body · SELL: Bearish close + upper wick > body"
            />
            <StrategyRule
              title="Stop Loss"
              detail="SL = Swing High (bearish) · Swing Low (bullish) — level 100%/0%"
            />
            <StrategyRule
              title="Take Profit"
              detail="TP = Swing Low (bearish) · Swing High (bullish) — level 0%/100%"
            />
            <StrategyRule
              title="Trade Filter"
              detail="Max 1 active signal · No entry on low ATR or extreme spread"
              isLast
            />
          </View>
        </View>

        {/* Notification Section */}
        {Platform.OS !== "web" && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>NOTIFIKASI</Text>
            <View style={styles.card}>
              <View style={styles.notifRow}>
                <View style={styles.notifLeft}>
                  <Ionicons
                    name={notificationEnabled ? "notifications" : "notifications-off"}
                    size={20}
                    color={notificationEnabled ? C.gold : C.textDim}
                  />
                  <View>
                    <Text style={styles.notifLabel}>Push Notification</Text>
                    <Text style={styles.notifSub}>
                      {notificationEnabled ? "Aktif — Sinyal BUY/SELL, TP & SL" : "Nonaktif — Ketuk untuk aktifkan"}
                    </Text>
                  </View>
                </View>
                <Switch
                  value={notificationEnabled}
                  onValueChange={(v) => {
                    if (v) {
                      requestNotifications();
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    } else {
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      Alert.alert(
                        "Notifikasi Aktif",
                        "Notifikasi tidak dapat dinonaktifkan dari sini. Matikan melalui pengaturan sistem perangkat Anda.",
                        [{ text: "OK" }]
                      );
                    }
                  }}
                  trackColor={{ false: C.border, true: C.goldBg }}
                  thumbColor={notificationEnabled ? C.gold : C.textDim}
                />
              </View>
              <View style={[styles.divider, { marginHorizontal: 0 }]} />
              <View style={styles.notifInfoBox}>
                <Ionicons name="information-circle" size={14} color={C.gold} />
                <Text style={styles.notifInfoText}>
                  <Text style={{ color: C.gold, fontFamily: "Inter_600SemiBold" }}>✅ Push Notification seperti WhatsApp aktif!</Text>{"\n\n"}
                  Server LIBARTIN berjalan 24/7 dan terhubung langsung ke Deriv. Ketika sinyal BUY atau SELL terdeteksi, server langsung mengirim notifikasi ke HP kamu — meski aplikasi sedang ditutup sekalipun.{"\n\n"}
                  <Text style={{ color: "#A78BFA", fontFamily: "Inter_600SemiBold" }}>Yang kamu terima:</Text>{"\n"}
                  {"  "}🟢 Sinyal BUY — entry, SL, TP, R:R{"\n"}
                  {"  "}🔴 Sinyal SELL — entry, SL, TP, R:R{"\n"}
                  {"  "}✅ Take Profit tercapai{"\n"}
                  {"  "}🛑 Stop Loss kena
                </Text>
              </View>
            </View>
          </View>
        )}

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>ABOUT</Text>
          <View style={styles.card}>
            <View style={styles.aboutRow}>
              <MaterialCommunityIcons name="finance" size={24} color={C.gold} />
              <View style={styles.aboutText}>
                <Text style={styles.aboutTitle}>LIBARTIN</Text>
                <Text style={styles.aboutSub}>
                  Analisis Fibonacci Deterministic untuk XAUUSD · Semua keputusan berbasis matematika murni · Tidak ada asumsi visual atau random
                </Text>
              </View>
            </View>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  header: {
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
  section: {
    paddingHorizontal: 16,
    marginBottom: 16,
  },
  sectionTitle: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 11,
    color: C.textDim,
    letterSpacing: 1.5,
    marginBottom: 8,
  },
  card: {
    backgroundColor: C.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: C.border,
    overflow: "hidden",
  },
  divider: {
    height: 1,
    backgroundColor: C.border,
    marginHorizontal: 16,
  },
  infoRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  infoLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  infoLabel: {
    fontFamily: "Inter_500Medium",
    fontSize: 14,
    color: C.text,
  },
  infoValue: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 14,
    color: C.textSub,
  },
  ruleRow: {
    flexDirection: "row",
    gap: 12,
    padding: 14,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  ruleRowLast: {
    borderBottomWidth: 0,
  },
  ruleDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: C.gold,
    marginTop: 6,
  },
  ruleContent: { flex: 1 },
  ruleTitle: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
    color: C.text,
    marginBottom: 2,
  },
  ruleDetail: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    color: C.textSub,
    lineHeight: 18,
  },
  aboutRow: {
    flexDirection: "row",
    gap: 12,
    padding: 16,
    alignItems: "flex-start",
  },
  aboutText: { flex: 1 },
  aboutTitle: {
    fontFamily: "Orbitron_900Black",
    fontSize: 15,
    color: C.gold,
    letterSpacing: 1.5,
    marginBottom: 4,
  },
  aboutSub: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    color: C.textSub,
    lineHeight: 18,
  },
  notifRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  notifLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    flex: 1,
  },
  notifLabel: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 14,
    color: C.text,
  },
  notifSub: {
    fontFamily: "Inter_400Regular",
    fontSize: 11,
    color: C.textDim,
    marginTop: 1,
  },
  notifInfoBox: {
    flexDirection: "row",
    gap: 8,
    padding: 14,
    alignItems: "flex-start",
  },
  notifInfoText: {
    fontFamily: "Inter_400Regular",
    fontSize: 11,
    color: C.textDim,
    lineHeight: 17,
    flex: 1,
  },
  demoDesc: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    color: C.textSub,
    lineHeight: 18,
    padding: 14,
    paddingBottom: 6,
  },
  demoPrice: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 12,
    color: C.gold,
    paddingHorizontal: 14,
    paddingBottom: 10,
  },
  demoRow: {
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 14,
    paddingBottom: 12,
  },
  demoBtnBuy: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: C.green,
    borderRadius: 12,
    paddingVertical: 14,
  },
  demoBtnSell: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: C.red,
    borderRadius: 12,
    paddingVertical: 14,
  },
  demoBtnActive: {
    opacity: 0.7,
  },
  demoBtnText: {
    fontFamily: "Inter_700Bold",
    fontSize: 13,
    color: "#fff",
  },
  demoClearBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    marginHorizontal: 14,
    marginBottom: 10,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 10,
  },
  demoClearText: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    color: C.textSub,
  },
  demoNote: {
    flexDirection: "row",
    gap: 6,
    padding: 14,
    paddingTop: 2,
    alignItems: "flex-start",
  },
  demoNoteText: {
    fontFamily: "Inter_400Regular",
    fontSize: 11,
    color: C.textDim,
    lineHeight: 16,
    flex: 1,
  },
});
