import React, { useEffect, useRef, useState, useCallback } from "react";
import {
  Animated,
  TouchableOpacity,
  Text,
  View,
  StyleSheet,
  Platform,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import C from "@/constants/colors";

interface AIMessage {
  id: string;
  role: "assistant" | "user";
  content: string;
  type: "signal" | "outcome" | "market" | "user_chat" | "system";
  timestamp: string;
  metadata?: {
    signalId?: string;
    trend?: string;
    outcome?: "win" | "loss";
    entryPrice?: number;
  };
}

function getBackendUrl(): string {
  if (typeof window !== "undefined" && window.location?.origin) {
    return window.location.origin;
  }
  if (typeof process !== "undefined" && process.env.EXPO_PUBLIC_DOMAIN) {
    const domain = process.env.EXPO_PUBLIC_DOMAIN;
    if (domain.startsWith("http")) return domain;
    return `https://${domain.replace(/:5000$/, "")}`;
  }
  return "";
}

const BACKEND_URL = getBackendUrl();
const POLL_MS = 5000;
const TOAST_DURATION = 6000;

function getToastStyle(msg: AIMessage): {
  borderColor: string;
  icon: keyof typeof Ionicons.glyphMap;
  iconColor: string;
  label: string;
  labelColor: string;
} {
  if (msg.type === "signal") {
    const isBull = msg.metadata?.trend === "Bullish";
    return {
      borderColor: isBull ? C.green : C.red,
      icon: isBull ? "trending-up" : "trending-down",
      iconColor: isBull ? C.green : C.red,
      label: isBull ? "SINYAL BUY TERDETEKSI" : "SINYAL SELL TERDETEKSI",
      labelColor: isBull ? C.green : C.red,
    };
  }
  if (msg.type === "outcome") {
    const isWin = msg.metadata?.outcome === "win";
    return {
      borderColor: isWin ? C.green : "#F97316",
      icon: isWin ? "trophy" : "refresh-circle",
      iconColor: isWin ? C.green : "#F97316",
      label: isWin ? "TP HIT — SELAMAT!" : "SL HIT — SEMANGAT!",
      labelColor: isWin ? C.green : "#F97316",
    };
  }
  return {
    borderColor: C.gold,
    icon: "sparkles",
    iconColor: C.gold,
    label: "LIBARTIN AI",
    labelColor: C.gold,
  };
}

export function AIToast() {
  const [toast, setToast] = useState<AIMessage | null>(null);
  const slideAnim = useRef(new Animated.Value(-120)).current;
  const lastSeenIdRef = useRef<string | null>(null);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialLoadRef = useRef(true);

  const dismiss = useCallback(() => {
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    Animated.timing(slideAnim, {
      toValue: -120,
      duration: 280,
      useNativeDriver: Platform.OS !== "web",
    }).start(() => setToast(null));
  }, [slideAnim]);

  const showToast = useCallback(
    (msg: AIMessage) => {
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
      setToast(msg);
      slideAnim.setValue(-120);
      Animated.spring(slideAnim, {
        toValue: 0,
        useNativeDriver: Platform.OS !== "web",
        tension: 80,
        friction: 10,
      }).start();
      dismissTimerRef.current = setTimeout(dismiss, TOAST_DURATION);
    },
    [slideAnim, dismiss]
  );

  const fetchMessages = useCallback(async () => {
    if (!BACKEND_URL) return;
    try {
      const res = await fetch(`${BACKEND_URL}/api/ai/messages?limit=5`);
      if (!res.ok) return;
      const data = (await res.json()) as { messages: AIMessage[] };
      const msgs = data.messages ?? [];

      // Cari pesan AI terbaru yang bertipe signal atau outcome
      const latest = msgs.find(
        (m) =>
          m.role === "assistant" &&
          (m.type === "signal" || m.type === "outcome")
      );

      if (!latest) return;

      // Pada load pertama, simpan ID terakhir tanpa show toast
      if (initialLoadRef.current) {
        lastSeenIdRef.current = latest.id;
        initialLoadRef.current = false;
        return;
      }

      // Jika ada pesan baru yang belum pernah ditampilkan
      if (latest.id !== lastSeenIdRef.current) {
        lastSeenIdRef.current = latest.id;
        showToast(latest);
      }
    } catch {}
  }, [showToast]);

  useEffect(() => {
    fetchMessages();
    const interval = setInterval(fetchMessages, POLL_MS);
    return () => {
      clearInterval(interval);
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    };
  }, [fetchMessages]);

  if (!toast) return null;

  const { borderColor, icon, iconColor, label, labelColor } =
    getToastStyle(toast);
  const preview =
    toast.content.length > 110
      ? toast.content.slice(0, 110) + "..."
      : toast.content;

  return (
    <Animated.View
      style={[styles.wrapper, { transform: [{ translateY: slideAnim }] }]}
      pointerEvents="box-none"
    >
      <TouchableOpacity
        style={[styles.card, { borderLeftColor: borderColor }]}
        onPress={() => {
          dismiss();
          router.push("/(tabs)/ai");
        }}
        activeOpacity={0.85}
      >
        <View style={styles.row}>
          <View
            style={[
              styles.iconWrap,
              { backgroundColor: iconColor + "20", borderColor: iconColor + "40" },
            ]}
          >
            <Ionicons name={icon} size={16} color={iconColor} />
          </View>
          <View style={styles.textBlock}>
            <View style={styles.labelRow}>
              <Text style={[styles.label, { color: labelColor }]}>{label}</Text>
              <Ionicons name="sparkles" size={10} color={C.gold} />
            </View>
            <Text style={styles.preview} numberOfLines={3}>
              {preview}
            </Text>
          </View>
          <TouchableOpacity style={styles.closeBtn} onPress={dismiss} hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}>
            <Ionicons name="close" size={16} color={C.textDim} />
          </TouchableOpacity>
        </View>
        <Text style={styles.tapHint}>Ketuk untuk buka AI Chat</Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    position: "absolute",
    top: Platform.OS === "ios" ? 54 : 16,
    left: 12,
    right: 12,
    zIndex: 9999,
  },
  card: {
    backgroundColor: C.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: C.border,
    borderLeftWidth: 4,
    padding: 12,
    gap: 8,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 12,
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
  },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 2,
    flexShrink: 0,
  },
  textBlock: {
    flex: 1,
    gap: 4,
  },
  labelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  label: {
    fontFamily: "Inter_700Bold",
    fontSize: 10,
    letterSpacing: 1.2,
  },
  preview: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    color: C.textSub,
    lineHeight: 18,
  },
  closeBtn: {
    marginTop: 2,
    padding: 2,
    flexShrink: 0,
  },
  tapHint: {
    fontFamily: "Inter_400Regular",
    fontSize: 10,
    color: C.textDim,
    textAlign: "right",
  },
});
