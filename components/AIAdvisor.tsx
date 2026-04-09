import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Platform,
  KeyboardAvoidingView,
  Animated,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
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
  const explicit = process.env.EXPO_PUBLIC_BACKEND_URL;
  if (explicit) return explicit.startsWith("http") ? explicit : `https://${explicit}`;
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
}

const BACKEND_URL = getBackendUrl();

const POLL_INTERVAL = 6000;

function getTypeLabel(type: AIMessage["type"], metadata?: AIMessage["metadata"]): { label: string; color: string } {
  if (type === "signal") {
    const isBull = metadata?.trend === "Bullish";
    return { label: isBull ? "BUY SIGNAL" : "SELL SIGNAL", color: isBull ? C.green : C.red };
  }
  if (type === "outcome") {
    const isWin = metadata?.outcome === "win";
    return { label: isWin ? "TP HIT — WIN" : "SL HIT — LOSS", color: isWin ? C.green : C.red };
  }
  if (type === "user_chat" && metadata === undefined) {
    return { label: "KAMU", color: C.blue };
  }
  return { label: "AI ANALISIS", color: C.gold };
}

function MessageBubble({ msg }: { msg: AIMessage }) {
  const isUser = msg.role === "user";
  const { label, color } = getTypeLabel(isUser ? "user_chat" : msg.type, msg.metadata);

  return (
    <View style={[styles.bubbleWrapper, isUser && styles.bubbleWrapperUser]}>
      {!isUser && (
        <View style={styles.bubbleHeader}>
          <View style={[styles.typeBadge, { backgroundColor: color + "20", borderColor: color + "40" }]}>
            <Text style={[styles.typeBadgeText, { color }]}>{label}</Text>
          </View>
          <Text style={styles.bubbleTime}>
            {(() => {
              try {
                return new Date(msg.timestamp).toLocaleTimeString("id-ID", {
                  hour: "2-digit",
                  minute: "2-digit",
                });
              } catch {
                return msg.timestamp;
              }
            })()}
          </Text>
        </View>
      )}
      <View style={[
        styles.bubble,
        isUser ? styles.bubbleUser : styles.bubbleAI,
        !isUser && { borderColor: color + "30" },
      ]}>
        <Text style={[styles.bubbleText, isUser && styles.bubbleTextUser]}>
          {msg.content}
        </Text>
      </View>
    </View>
  );
}

function TypingIndicator() {
  const dot1 = useRef(new Animated.Value(0.3)).current;
  const dot2 = useRef(new Animated.Value(0.3)).current;
  const dot3 = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    const animate = (dot: Animated.Value, delay: number) => {
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(dot, { toValue: 1, duration: 400, useNativeDriver: Platform.OS !== "web" }),
          Animated.timing(dot, { toValue: 0.3, duration: 400, useNativeDriver: Platform.OS !== "web" }),
        ])
      ).start();
    };
    animate(dot1, 0);
    animate(dot2, 150);
    animate(dot3, 300);
  }, [dot1, dot2, dot3]);

  return (
    <View style={styles.typingRow}>
      {[dot1, dot2, dot3].map((dot, i) => (
        <Animated.View key={i} style={[styles.typingDot, { opacity: dot }]} />
      ))}
      <Text style={styles.typingText}>AI sedang menganalisis...</Text>
    </View>
  );
}

export function AIAdvisor() {
  const [messages, setMessages] = useState<AIMessage[]>([]);
  const [inputText, setInputText] = useState("");
  const [sending, setSending] = useState(false);
  const [aiReady, setAiReady] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [connectionError, setConnectionError] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const lastMsgCountRef = useRef(0);
  const fetchFailCountRef = useRef(0);

  const fetchMessages = useCallback(async () => {
    if (!BACKEND_URL) {
      setConnectionError(true);
      return;
    }
    try {
      const res = await fetch(`${BACKEND_URL}/api/ai/messages?limit=20`);
      if (!res.ok) {
        fetchFailCountRef.current += 1;
        if (fetchFailCountRef.current >= 3) setConnectionError(true);
        return;
      }
      fetchFailCountRef.current = 0;
      setConnectionError(false);
      const data = await res.json() as { messages: AIMessage[]; ready: boolean };
      setMessages(data.messages ?? []);
      setAiReady(data.ready ?? true);

      if (data.messages.length > lastMsgCountRef.current) {
        lastMsgCountRef.current = data.messages.length;
        if (expanded) {
          setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
        }
      }
    } catch {
      fetchFailCountRef.current += 1;
      if (fetchFailCountRef.current >= 3) setConnectionError(true);
    }
  }, [expanded]);

  useEffect(() => {
    fetchMessages();
    const interval = setInterval(fetchMessages, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchMessages]);

  const sendMessage = useCallback(async () => {
    const msg = inputText.trim();
    if (!msg || sending) return;

    if (!BACKEND_URL) {
      setMessages((prev) => [
        {
          id: `err_${Date.now()}`,
          role: "assistant" as const,
          content: "Server tidak terhubung. Pastikan aplikasi terhubung ke internet dan server berjalan.",
          type: "system" as const,
          timestamp: new Date().toUTCString(),
        },
        ...prev,
      ]);
      return;
    }

    setSending(true);
    setInputText("");

    const optimisticMsg: AIMessage = {
      id: `user_${Date.now()}`,
      role: "user",
      content: msg,
      type: "user_chat",
      timestamp: new Date().toUTCString(),
    };
    setMessages((prev) => [optimisticMsg, ...prev]);
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 40000);

      const res = await fetch(`${BACKEND_URL}/api/ai/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: msg }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (res.ok) {
        const data = await res.json() as { messages: AIMessage[]; response?: string };
        if (data.messages && data.messages.length > 0) {
          setMessages(data.messages);
        } else if (data.response) {
          const aiMsg: AIMessage = {
            id: `ai_${Date.now()}`,
            role: "assistant",
            content: data.response,
            type: "user_chat",
            timestamp: new Date().toUTCString(),
          };
          setMessages((prev) => [aiMsg, ...prev]);
        }
        setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
      } else {
        let errText = "AI tidak dapat merespons sekarang.";
        try {
          const errData = await res.json() as { error?: string };
          if (errData.error) errText = errData.error;
        } catch {}
        setMessages((prev) => [
          {
            id: `err_${Date.now()}`,
            role: "assistant" as const,
            content: errText,
            type: "system" as const,
            timestamp: new Date().toUTCString(),
          },
          ...prev,
        ]);
      }
    } catch (e: unknown) {
      const isAborted = e instanceof Error && e.name === "AbortError";
      setMessages((prev) => [
        {
          id: `err_${Date.now()}`,
          role: "assistant" as const,
          content: isAborted
            ? "Permintaan AI timeout (>40 detik). Coba lagi dengan pertanyaan yang lebih singkat."
            : "Koneksi ke server bermasalah. Periksa koneksi internet dan coba lagi.",
          type: "system" as const,
          timestamp: new Date().toUTCString(),
        },
        ...prev,
      ]);
    } finally {
      setSending(false);
    }
  }, [inputText, sending]);

  const visibleMessages = [...messages].reverse();

  if (!expanded) {
    const latestAI = messages.find((m) => m.role === "assistant");
    return (
      <TouchableOpacity
        style={styles.collapsedCard}
        onPress={() => setExpanded(true)}
        activeOpacity={0.8}
      >
        <View style={styles.collapsedHeader}>
          <View style={styles.collapsedLeft}>
            <View style={styles.aiIconWrap}>
              <Ionicons name="sparkles" size={16} color={C.gold} />
            </View>
            <View>
              <Text style={styles.collapsedTitle}>LIBARTIN AI</Text>
              <Text style={styles.collapsedSub}>Asisten Analisis XAUUSD</Text>
            </View>
          </View>
          <View style={styles.collapsedRight}>
            {!aiReady && <ActivityIndicator size="small" color={C.gold} />}
            <Ionicons name="chevron-down" size={18} color={C.textDim} />
          </View>
        </View>
        {latestAI ? (
          <Text style={styles.collapsedPreview} numberOfLines={2}>
            {latestAI.content}
          </Text>
        ) : connectionError ? (
          <Text style={[styles.collapsedEmpty, { color: C.red }]}>
            AI Advisor tidak dapat terhubung. Ketuk untuk detail.
          </Text>
        ) : (
          <Text style={styles.collapsedEmpty}>
            AI akan otomatis memberikan analisis saat sinyal terdeteksi.
          </Text>
        )}
      </TouchableOpacity>
    );
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={styles.container}
    >
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <View style={styles.aiIconWrap}>
            <Ionicons name="sparkles" size={16} color={C.gold} />
          </View>
          <View>
            <Text style={styles.headerTitle}>LIBARTIN AI</Text>
            <Text style={styles.headerSub}>Asisten Analisis XAUUSD · Real-time</Text>
          </View>
        </View>
        <TouchableOpacity onPress={() => setExpanded(false)} style={styles.collapseBtn}>
          <Ionicons name="chevron-up" size={20} color={C.textDim} />
        </TouchableOpacity>
      </View>

      <ScrollView
        ref={scrollRef}
        style={styles.messageList}
        contentContainerStyle={styles.messageListContent}
        showsVerticalScrollIndicator={false}
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
      >
        {visibleMessages.length === 0 && connectionError && (
          <View style={styles.emptyState}>
            <Ionicons name="cloud-offline-outline" size={32} color={C.red} />
            <Text style={[styles.emptyTitle, { color: C.red }]}>AI Advisor Offline</Text>
            <Text style={styles.emptyText}>
              Tidak dapat terhubung ke server AI. Pastikan koneksi internet aktif dan coba lagi. Sinyal trading tetap berjalan normal di tab lain.
            </Text>
          </View>
        )}
        {visibleMessages.length === 0 && !connectionError && (
          <View style={styles.emptyState}>
            <Ionicons name="sparkles-outline" size={32} color={C.textDim} />
            <Text style={styles.emptyTitle}>AI Siap Bertugas</Text>
            <Text style={styles.emptyText}>
              AI akan otomatis menganalisis kondisi pasar dan memberikan rekomendasi saat ada sinyal BUY/SELL. Kamu juga bisa bertanya langsung.
            </Text>
          </View>
        )}
        {!aiReady && <TypingIndicator />}
        {visibleMessages.map((msg) => (
          <MessageBubble key={msg.id} msg={msg} />
        ))}
      </ScrollView>

      <View style={styles.inputArea}>
        <TextInput
          style={styles.input}
          value={inputText}
          onChangeText={setInputText}
          placeholder="Tanya AI tentang kondisi market..."
          placeholderTextColor={C.textDim}
          multiline
          maxLength={500}
          onSubmitEditing={sendMessage}
          returnKeyType="send"
          blurOnSubmit
        />
        <TouchableOpacity
          style={[styles.sendBtn, (!inputText.trim() || sending) && styles.sendBtnDisabled]}
          onPress={sendMessage}
          disabled={!inputText.trim() || sending}
        >
          {sending ? (
            <ActivityIndicator size="small" color={C.bg} />
          ) : (
            <Ionicons name="send" size={16} color={C.bg} />
          )}
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: C.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: C.border,
    overflow: "hidden",
    maxHeight: 480,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
    backgroundColor: C.cardAlt,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  headerTitle: {
    fontFamily: "Orbitron_900Black",
    fontSize: 13,
    color: C.gold,
    letterSpacing: 1.5,
  },
  headerSub: {
    fontFamily: "Inter_400Regular",
    fontSize: 10,
    color: C.textSub,
    marginTop: 1,
  },
  collapseBtn: {
    padding: 4,
  },
  aiIconWrap: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: C.goldBg,
    borderWidth: 1,
    borderColor: C.gold + "40",
    alignItems: "center",
    justifyContent: "center",
  },
  messageList: {
    flex: 1,
    maxHeight: 320,
  },
  messageListContent: {
    padding: 12,
    gap: 10,
    flexGrow: 1,
    justifyContent: "flex-end",
  },
  emptyState: {
    alignItems: "center",
    paddingVertical: 24,
    gap: 8,
  },
  emptyTitle: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 14,
    color: C.textSub,
  },
  emptyText: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    color: C.textDim,
    textAlign: "center",
    lineHeight: 18,
    paddingHorizontal: 8,
  },
  typingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 4,
  },
  typingDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: C.gold,
  },
  typingText: {
    fontFamily: "Inter_400Regular",
    fontSize: 11,
    color: C.textDim,
  },
  bubbleWrapper: {
    alignSelf: "flex-start",
    maxWidth: "92%",
    gap: 4,
  },
  bubbleWrapperUser: {
    alignSelf: "flex-end",
  },
  bubbleHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  typeBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    borderWidth: 1,
  },
  typeBadgeText: {
    fontFamily: "Inter_700Bold",
    fontSize: 9,
    letterSpacing: 1,
  },
  bubbleTime: {
    fontFamily: "Inter_400Regular",
    fontSize: 10,
    color: C.textDim,
  },
  bubble: {
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
  },
  bubbleAI: {
    backgroundColor: C.cardAlt,
    borderTopLeftRadius: 4,
  },
  bubbleUser: {
    backgroundColor: C.blue + "25",
    borderColor: C.blue + "40",
    borderTopRightRadius: 4,
    alignSelf: "flex-end",
  },
  bubbleText: {
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    color: C.text,
    lineHeight: 20,
  },
  bubbleTextUser: {
    color: C.text,
  },
  inputArea: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: C.border,
    backgroundColor: C.cardAlt,
  },
  input: {
    flex: 1,
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    color: C.text,
    backgroundColor: C.bg,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    maxHeight: 80,
    minHeight: 40,
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: C.gold,
    alignItems: "center",
    justifyContent: "center",
  },
  sendBtnDisabled: {
    backgroundColor: C.textDim,
  },
  collapsedCard: {
    backgroundColor: C.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: C.border,
    padding: 14,
    gap: 8,
  },
  collapsedHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  collapsedLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  collapsedRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  collapsedTitle: {
    fontFamily: "Orbitron_900Black",
    fontSize: 12,
    color: C.gold,
    letterSpacing: 1.5,
  },
  collapsedSub: {
    fontFamily: "Inter_400Regular",
    fontSize: 10,
    color: C.textDim,
    marginTop: 1,
  },
  collapsedPreview: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    color: C.textSub,
    lineHeight: 18,
    paddingLeft: 2,
  },
  collapsedEmpty: {
    fontFamily: "Inter_400Regular",
    fontSize: 11,
    color: C.textDim,
    lineHeight: 17,
    paddingLeft: 2,
    fontStyle: "italic",
  },
});
