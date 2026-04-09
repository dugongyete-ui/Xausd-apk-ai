import React, {
  useState,
  useRef,
  useCallback,
  useEffect,
} from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  FlatList,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Animated,
  LayoutAnimation,
  UIManager,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import C from "@/constants/colors";

if (Platform.OS === "android" && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// ─── Backend URL ───────────────────────────────────────────────────────────────
function getBackendUrl(): string {
  const explicit = process.env.EXPO_PUBLIC_BACKEND_URL;
  if (explicit) return explicit.startsWith("http") ? explicit : `https://${explicit}`;
  if (typeof window !== "undefined" && window.location?.origin) {
    return window.location.origin;
  }
  const domain = process.env.EXPO_PUBLIC_DOMAIN ?? "";
  if (!domain) return "";
  if (domain.startsWith("http")) return domain;
  const clean = domain.replace(/:5000$/, "");
  return `https://${clean}`;
}
const BACKEND_URL = getBackendUrl();

// ─── Types ────────────────────────────────────────────────────────────────────
interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  streaming?: boolean;
  thinkingPhase?: boolean;
}

// ─── Typing Dots Animation ─────────────────────────────────────────────────────
function TypingDots() {
  const dot1 = useRef(new Animated.Value(0)).current;
  const dot2 = useRef(new Animated.Value(0)).current;
  const dot3 = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const animate = (dot: Animated.Value, delay: number) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(dot, { toValue: 1, duration: 300, useNativeDriver: true }),
          Animated.timing(dot, { toValue: 0, duration: 300, useNativeDriver: true }),
          Animated.delay(600 - delay),
        ])
      );

    const a1 = animate(dot1, 0);
    const a2 = animate(dot2, 200);
    const a3 = animate(dot3, 400);
    a1.start();
    a2.start();
    a3.start();

    return () => {
      a1.stop();
      a2.stop();
      a3.stop();
    };
  }, [dot1, dot2, dot3]);

  const dotStyle = (anim: Animated.Value) => ({
    opacity: anim,
    transform: [
      {
        translateY: anim.interpolate({
          inputRange: [0, 1],
          outputRange: [0, -6],
        }),
      },
    ],
  });

  return (
    <View style={typingStyles.container}>
      <Animated.View style={[typingStyles.dot, dotStyle(dot1)]} />
      <Animated.View style={[typingStyles.dot, dotStyle(dot2)]} />
      <Animated.View style={[typingStyles.dot, dotStyle(dot3)]} />
    </View>
  );
}

const typingStyles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: C.gold,
  },
});

// ─── Thinking Process Panel ────────────────────────────────────────────────────
function ThinkingProcess({ thinking }: { thinking: string }) {
  const [expanded, setExpanded] = useState(false);

  const toggle = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpanded((v) => !v);
  };

  return (
    <View style={thinkStyles.wrapper}>
      <Pressable onPress={toggle} style={thinkStyles.header}>
        <View style={thinkStyles.headerLeft}>
          <Ionicons name="flash" size={13} color={C.gold} />
          <Text style={thinkStyles.headerLabel}>Proses Berpikir</Text>
        </View>
        <Ionicons
          name={expanded ? "chevron-up" : "chevron-down"}
          size={14}
          color={C.textDim}
        />
      </Pressable>
      {expanded && (
        <View style={thinkStyles.body}>
          <Text style={thinkStyles.text}>{thinking}</Text>
        </View>
      )}
    </View>
  );
}

const thinkStyles = StyleSheet.create({
  wrapper: {
    marginBottom: 6,
    marginLeft: 40,
    marginRight: 16,
    borderRadius: 10,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: C.gold + "33",
    backgroundColor: C.gold + "0A",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  headerLabel: {
    fontFamily: "Inter_500Medium",
    fontSize: 12,
    color: C.gold,
    letterSpacing: 0.3,
  },
  body: {
    paddingHorizontal: 12,
    paddingBottom: 10,
    borderTopWidth: 1,
    borderTopColor: C.gold + "22",
  },
  text: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    color: C.textSub,
    lineHeight: 18,
    marginTop: 8,
  },
});

// ─── Thinking Phase Bubble (saat AI sedang berpikir) ─────────────────────────
function ThinkingPhaseBubble() {
  const pulse = useRef(new Animated.Value(0.5)).current;

  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 800, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.5, duration: 800, useNativeDriver: true }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [pulse]);

  return (
    <View style={[bubbleStyles.row, bubbleStyles.rowLeft]}>
      <View style={bubbleStyles.avatarAI}>
        <Text style={bubbleStyles.avatarText}>AI</Text>
      </View>
      <Animated.View style={[thinkPhaseStyles.bubble, { opacity: pulse }]}>
        <Ionicons name="flash" size={12} color={C.gold} />
        <Text style={thinkPhaseStyles.text}>Sedang menganalisis...</Text>
      </Animated.View>
    </View>
  );
}

const thinkPhaseStyles = StyleSheet.create({
  bubble: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: C.gold + "15",
    borderWidth: 1,
    borderColor: C.gold + "44",
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  text: {
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    color: C.gold,
    opacity: 0.9,
  },
});

// ─── Message Bubble ────────────────────────────────────────────────────────────
function MessageBubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === "user";

  if (msg.thinkingPhase) {
    return <ThinkingPhaseBubble />;
  }

  if (msg.streaming && !msg.content) {
    return (
      <View style={[bubbleStyles.row, bubbleStyles.rowLeft]}>
        <View style={bubbleStyles.avatarAI}>
          <Text style={bubbleStyles.avatarText}>AI</Text>
        </View>
        <View style={[bubbleStyles.bubble, bubbleStyles.bubbleAI]}>
          <TypingDots />
        </View>
      </View>
    );
  }

  return (
    <View>
      {!isUser && msg.thinking && (
        <ThinkingProcess thinking={msg.thinking} />
      )}
      <View style={[bubbleStyles.row, isUser ? bubbleStyles.rowRight : bubbleStyles.rowLeft]}>
        {!isUser && (
          <View style={bubbleStyles.avatarAI}>
            <Text style={bubbleStyles.avatarText}>AI</Text>
          </View>
        )}
        <View
          style={[
            bubbleStyles.bubble,
            isUser ? bubbleStyles.bubbleUser : bubbleStyles.bubbleAI,
          ]}
        >
          <Text style={[bubbleStyles.text, isUser ? bubbleStyles.textUser : bubbleStyles.textAI]}>
            {msg.content}
            {msg.streaming && <Text style={bubbleStyles.cursor}>▌</Text>}
          </Text>
        </View>
        {isUser && (
          <View style={bubbleStyles.avatarUser}>
            <Ionicons name="person" size={14} color={C.bg} />
          </View>
        )}
      </View>
    </View>
  );
}

const bubbleStyles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "flex-end",
    marginBottom: 12,
    paddingHorizontal: 12,
    gap: 8,
  },
  rowLeft: { justifyContent: "flex-start" },
  rowRight: { justifyContent: "flex-end" },
  avatarAI: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: C.goldBg,
    borderWidth: 1,
    borderColor: C.gold,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  avatarUser: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: C.gold,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  avatarText: {
    fontFamily: "Inter_700Bold",
    fontSize: 10,
    color: C.gold,
    letterSpacing: 0.5,
  },
  bubble: {
    maxWidth: "75%",
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  bubbleUser: {
    backgroundColor: C.gold,
    borderBottomRightRadius: 4,
  },
  bubbleAI: {
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.border,
    borderBottomLeftRadius: 4,
  },
  text: {
    fontSize: 14,
    lineHeight: 20,
  },
  textUser: {
    fontFamily: "Inter_500Medium",
    color: C.bg,
  },
  textAI: {
    fontFamily: "Inter_400Regular",
    color: C.text,
  },
  cursor: {
    color: C.gold,
    opacity: 0.8,
  },
});

// ─── Empty State ───────────────────────────────────────────────────────────────
function EmptyState({ onHintPress }: { onHintPress: (text: string) => void }) {
  return (
    <View style={emptyStyles.container}>
      <View style={emptyStyles.iconWrap}>
        <Ionicons name="sparkles" size={36} color={C.gold} />
      </View>
      <Text style={emptyStyles.title}>LIBARTIN AI</Text>
      <Text style={emptyStyles.sub}>
        Tanya kondisi pasar, analisis sinyal, atau apapun tentang trading XAUUSD
      </Text>
      <View style={emptyStyles.thinkingBadge}>
        <Ionicons name="flash" size={11} color={C.gold} />
        <Text style={emptyStyles.thinkingBadgeText}>Mode Berpikir Aktif</Text>
      </View>
      <View style={emptyStyles.hints}>
        {[
          "Bagaimana kondisi market sekarang?",
          "Jelaskan sinyal SELL saat ini",
          "Apa itu Pin Bar dan kapan valid?",
        ].map((hint) => (
          <Pressable
            key={hint}
            style={({ pressed }) => [
              emptyStyles.hintChip,
              pressed && emptyStyles.hintChipPressed,
            ]}
            onPress={() => onHintPress(hint)}
          >
            <Text style={emptyStyles.hintText}>{hint}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const emptyStyles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
    paddingBottom: 60,
  },
  iconWrap: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: C.goldBg,
    borderWidth: 1,
    borderColor: C.gold + "44",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
  },
  title: {
    fontFamily: "Orbitron_700Bold",
    fontSize: 18,
    color: C.gold,
    letterSpacing: 2,
    marginBottom: 8,
  },
  sub: {
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    color: C.textSub,
    textAlign: "center",
    lineHeight: 20,
    marginBottom: 12,
  },
  thinkingBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: C.gold + "15",
    borderWidth: 1,
    borderColor: C.gold + "33",
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginBottom: 20,
  },
  thinkingBadgeText: {
    fontFamily: "Inter_500Medium",
    fontSize: 11,
    color: C.gold,
  },
  hints: { gap: 8, alignSelf: "stretch" },
  hintChip: {
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  hintChipPressed: {
    backgroundColor: C.goldBg,
    borderColor: C.gold + "66",
  },
  hintText: {
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    color: C.textSub,
  },
});

// ─── Main AI Chat Screen ───────────────────────────────────────────────────────
export default function AIScreen() {
  const insets = useSafeAreaInsets();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const flatListRef = useRef<FlatList>(null);
  const streamingIdRef = useRef<string | null>(null);
  const thinkingIdRef = useRef<string | null>(null);
  const inputRef = useRef<TextInput>(null);

  const scrollToBottom = useCallback(() => {
    setTimeout(() => {
      flatListRef.current?.scrollToEnd({ animated: true });
    }, 50);
  }, []);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || isStreaming) return;

    setInput("");

    const userMsg: ChatMessage = {
      id: `u_${Date.now()}`,
      role: "user",
      content: text,
    };

    // Thinking phase bubble — tampil selama AI berpikir
    const thinkingBubbleId = `think_${Date.now()}`;
    thinkingIdRef.current = thinkingBubbleId;

    const thinkingMsg: ChatMessage = {
      id: thinkingBubbleId,
      role: "assistant",
      content: "",
      thinkingPhase: true,
    };

    const msgId = `a_${Date.now() + 1}`;
    streamingIdRef.current = msgId;

    setMessages((prev) => [...prev, userMsg, thinkingMsg]);
    setIsStreaming(true);
    scrollToBottom();

    if (!BACKEND_URL) {
      setMessages((prev) => prev.filter((m) => m.id !== thinkingBubbleId));
      setMessages((prev) => [
        ...prev,
        { id: msgId, role: "assistant", content: "Backend tidak tersambung.", streaming: false },
      ]);
      setIsStreaming(false);
      return;
    }

    const showError = (errMsg: string) => {
      setMessages((prev) => prev.filter((m) => m.id !== thinkingBubbleId));
      setMessages((prev) => [
        ...prev,
        { id: msgId, role: "assistant", content: errMsg, streaming: false },
      ]);
      setIsStreaming(false);
    };

    try {
      const res = await fetch(`${BACKEND_URL}/api/ai/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        let errMsg = "AI tidak dapat dijangkau. Coba lagi sebentar.";
        try {
          const parsed = JSON.parse(errBody) as { error?: string };
          if (parsed.error) errMsg = parsed.error;
        } catch { /* ignore */ }
        showError(errMsg);
        return;
      }

      if (!res.body) {
        showError("Browser tidak mendukung streaming. Coba refresh halaman.");
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      let lineBuffer = "";
      let currentEvent = "";
      let contentBuilt = "";
      let thinkingReceived: string | undefined;
      let responseStarted = false;

      // Parse SSE line-by-line from the stream
      const processLines = (rawText: string) => {
        lineBuffer += rawText;
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trimEnd();

          if (trimmed.startsWith("event: ")) {
            currentEvent = trimmed.slice(7).trim();
          } else if (trimmed.startsWith("data: ")) {
            const rawData = trimmed.slice(6);

            if (currentEvent === "thinking") {
              try {
                const parsed = JSON.parse(rawData) as { thinking?: string };
                if (parsed.thinking) {
                  thinkingReceived = parsed.thinking;
                  // Replace thinking bubble → real message with thinking panel
                  setMessages((prev) => {
                    const filtered = prev.filter((m) => m.id !== thinkingBubbleId);
                    return [
                      ...filtered,
                      {
                        id: msgId,
                        role: "assistant" as const,
                        content: "",
                        thinking: thinkingReceived,
                        streaming: true,
                      },
                    ];
                  });
                  responseStarted = true;
                  scrollToBottom();
                }
              } catch { /* ignore */ }

            } else if (currentEvent === "chunk") {
              try {
                const parsed = JSON.parse(rawData) as { chunk?: string };
                if (parsed.chunk) {
                  contentBuilt += parsed.chunk;
                  const cur = contentBuilt;

                  if (!responseStarted) {
                    // No thinking received yet — replace bubble with real message
                    setMessages((prev) => {
                      const filtered = prev.filter((m) => m.id !== thinkingBubbleId);
                      return [
                        ...filtered,
                        {
                          id: msgId,
                          role: "assistant" as const,
                          content: cur,
                          streaming: true,
                        },
                      ];
                    });
                    responseStarted = true;
                  } else {
                    setMessages((prev) =>
                      prev.map((m) =>
                        m.id === msgId ? { ...m, content: cur, streaming: true } : m
                      )
                    );
                  }
                  scrollToBottom();
                }
              } catch { /* ignore */ }

            } else if (currentEvent === "done" || rawData === "[DONE]") {
              streamingIdRef.current = null;
              setMessages((prev) =>
                prev.map((m) => (m.id === msgId ? { ...m, streaming: false } : m))
              );
              setIsStreaming(false);

            } else if (currentEvent === "error") {
              try {
                const parsed = JSON.parse(rawData) as { error?: string };
                showError(parsed.error ?? "AI error");
              } catch {
                showError("AI mengalami error.");
              }
            }

            // Reset event name after processing data
            currentEvent = "";
          }
          // Empty line = event separator, already handled by resetting event above
        }
      };

      // Read stream until done
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        processLines(decoder.decode(value, { stream: true }));
      }

      // Finalize if stream ended without explicit done event
      if (streamingIdRef.current === msgId) {
        streamingIdRef.current = null;
        setMessages((prev) =>
          prev.map((m) => (m.id === msgId ? { ...m, streaming: false } : m))
        );
        setIsStreaming(false);
      }
    } catch (err: unknown) {
      const errMsg =
        err instanceof Error
          ? err.message
          : "Koneksi ke server gagal. Coba lagi dalam beberapa detik.";
      showError(errMsg);
    }
  }, [input, isStreaming, scrollToBottom]);

  const handleKeyPress = useCallback(
    (e: { nativeEvent: { key: string } }) => {
      if (Platform.OS === "web" && e.nativeEvent.key === "Enter") {
        sendMessage();
      }
    },
    [sendMessage]
  );

  const handleHintPress = useCallback((hint: string) => {
    setInput(hint);
    setTimeout(() => inputRef.current?.focus(), 100);
  }, []);

  const tabBarHeight = Platform.OS === "web" ? 84 : 60;

  return (
    <View style={[styles.root, { paddingTop: insets.top, paddingBottom: tabBarHeight + insets.bottom }]}>
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <View style={styles.headerDot} />
          <View>
            <Text style={styles.headerTitle}>LIBARTIN AI</Text>
            <Text style={styles.headerByline}>by Dzeck X Wakassim</Text>
          </View>
        </View>
        <View style={styles.headerRight}>
          <Ionicons name="flash" size={11} color={C.gold} />
          <Text style={styles.headerSub}>Thinking Mode</Text>
        </View>
      </View>

      <View style={styles.flex}>
        {messages.length === 0 ? (
          <EmptyState onHintPress={handleHintPress} />
        ) : (
          <FlatList
            ref={flatListRef}
            data={messages}
            keyExtractor={(m) => m.id}
            renderItem={({ item }) => <MessageBubble msg={item} />}
            contentContainerStyle={styles.listContent}
            onContentSizeChange={scrollToBottom}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            style={styles.flex}
          />
        )}
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : Platform.OS === "web" ? undefined : "height"}
        keyboardVerticalOffset={Platform.OS === "ios" ? 0 : 0}
      >
        <View style={styles.inputBar}>
          <View style={styles.inputRow}>
            <TextInput
              ref={inputRef}
              style={styles.input}
              value={input}
              onChangeText={setInput}
              placeholder="Tanya tentang XAUUSD..."
              placeholderTextColor={C.textDim}
              multiline
              maxLength={500}
              onKeyPress={handleKeyPress}
              onSubmitEditing={sendMessage}
              editable={!isStreaming}
              returnKeyType="send"
              blurOnSubmit={false}
              autoFocus={false}
              textAlignVertical="center"
            />
            <Pressable
              style={[styles.sendBtn, (!input.trim() || isStreaming) && styles.sendBtnDisabled]}
              onPress={sendMessage}
              disabled={!input.trim() || isStreaming}
            >
              {isStreaming ? (
                <ActivityIndicator size="small" color={C.bg} />
              ) : (
                <Ionicons name="send" size={18} color={C.bg} />
              )}
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: C.bg,
  },
  flex: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
    backgroundColor: C.surface,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  headerRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: C.gold + "15",
    borderWidth: 1,
    borderColor: C.gold + "33",
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  headerDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: C.gold,
  },
  headerTitle: {
    fontFamily: "Orbitron_700Bold",
    fontSize: 15,
    color: C.gold,
    letterSpacing: 2,
  },
  headerByline: {
    fontFamily: "Inter_400Regular",
    fontSize: 9,
    color: C.textDim,
    letterSpacing: 0.5,
    marginTop: 1,
  },
  headerSub: {
    fontFamily: "Inter_500Medium",
    fontSize: 11,
    color: C.gold,
  },
  listContent: {
    paddingTop: 16,
    paddingBottom: 8,
  },
  inputBar: {
    backgroundColor: C.surface,
    borderTopWidth: 1,
    borderTopColor: C.border,
    paddingTop: 10,
    paddingHorizontal: 12,
    paddingBottom: 8,
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 10,
  },
  input: {
    flex: 1,
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 10,
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    color: C.text,
    maxHeight: 120,
    minHeight: 44,
  },
  sendBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: C.gold,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  sendBtnDisabled: {
    opacity: 0.4,
  },
});
