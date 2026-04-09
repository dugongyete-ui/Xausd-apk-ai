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
  ScrollView,
  Alert,
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
  streamingThinking?: string;
  isThinkingStreaming?: boolean;
  streaming?: boolean;
  thinkingPhase?: boolean;
}

// ─── Blinking Cursor ───────────────────────────────────────────────────────────
function BlinkCursor({ color = C.text }: { color?: string }) {
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0, duration: 500, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 500, useNativeDriver: true }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [opacity]);
  return <Animated.Text style={{ opacity, color, fontSize: 14 }}>▌</Animated.Text>;
}

// ─── Thinking Disclosure Panel ─────────────────────────────────────────────────
function ThinkingPanel({
  text,
  isLive,
}: {
  text: string;
  isLive: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const pulse = useRef(new Animated.Value(0.5)).current;

  useEffect(() => {
    if (!isLive) return;
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 800, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.5, duration: 800, useNativeDriver: true }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [isLive, pulse]);

  const toggle = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpanded((v) => !v);
  };

  return (
    <View style={thinkStyles.wrapper}>
      <Pressable onPress={toggle} style={thinkStyles.header}>
        <View style={thinkStyles.left}>
          <Animated.View style={{ opacity: isLive ? pulse : 0.7 }}>
            <View style={thinkStyles.dot} />
          </Animated.View>
          <Text style={thinkStyles.label}>
            {isLive ? "Sedang berpikir..." : "Lihat proses berpikir"}
          </Text>
        </View>
        <Ionicons
          name={expanded ? "chevron-up-outline" : "chevron-down-outline"}
          size={14}
          color={C.textDim}
        />
      </Pressable>
      {expanded && (
        <View style={thinkStyles.body}>
          <ScrollView
            style={{ maxHeight: 200 }}
            showsVerticalScrollIndicator={false}
            nestedScrollEnabled
          >
            <Text style={thinkStyles.text}>
              {text || " "}
              {isLive && <BlinkCursor color={C.textDim} />}
            </Text>
          </ScrollView>
        </View>
      )}
    </View>
  );
}

const thinkStyles = StyleSheet.create({
  wrapper: {
    marginBottom: 4,
    borderRadius: 8,
    overflow: "hidden",
    backgroundColor: "#141C2B",
    borderWidth: 1,
    borderColor: C.border,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  left: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: C.gold,
  },
  label: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    color: C.textSub,
    letterSpacing: 0.2,
  },
  body: {
    paddingHorizontal: 12,
    paddingBottom: 12,
    borderTopWidth: 1,
    borderTopColor: C.border,
    paddingTop: 10,
  },
  text: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    color: C.textDim,
    lineHeight: 19,
  },
});

// ─── Thinking Phase Indicator ──────────────────────────────────────────────────
function ThinkingIndicator() {
  const pulse = useRef(new Animated.Value(0.4)).current;
  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.4, duration: 700, useNativeDriver: true }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [pulse]);

  return (
    <View style={indicatorStyles.row}>
      <Animated.View style={[indicatorStyles.dot, { opacity: pulse }]} />
      <Animated.View style={[indicatorStyles.dot, { opacity: pulse, marginLeft: 5 }]} />
      <Animated.View style={[indicatorStyles.dot, { opacity: pulse, marginLeft: 5 }]} />
    </View>
  );
}

const indicatorStyles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: C.textDim,
  },
});

// ─── Message Row ───────────────────────────────────────────────────────────────
function MessageRow({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === "user";

  if (msg.thinkingPhase) {
    return (
      <View style={rowStyles.aiRow}>
        <ThinkingIndicator />
      </View>
    );
  }

  if (msg.isThinkingStreaming) {
    return (
      <View style={rowStyles.aiRow}>
        <ThinkingPanel text={msg.streamingThinking ?? ""} isLive={true} />
      </View>
    );
  }

  if (msg.streaming && !msg.content) {
    return (
      <View style={rowStyles.aiRow}>
        <ThinkingIndicator />
      </View>
    );
  }

  if (isUser) {
    return (
      <View style={rowStyles.userRow}>
        <View style={rowStyles.userBubble}>
          <Text style={rowStyles.userText}>{msg.content}</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={rowStyles.aiRow}>
      {msg.thinking && (
        <ThinkingPanel text={msg.thinking} isLive={false} />
      )}
      {msg.streamingThinking && !msg.thinking && (
        <ThinkingPanel text={msg.streamingThinking} isLive={false} />
      )}
      <Text style={rowStyles.aiText}>
        {msg.content}
        {msg.streaming && <BlinkCursor />}
      </Text>
    </View>
  );
}

const rowStyles = StyleSheet.create({
  userRow: {
    alignItems: "flex-end",
    marginBottom: 20,
    paddingHorizontal: 16,
  },
  userBubble: {
    backgroundColor: "#1E2A3D",
    borderRadius: 16,
    borderBottomRightRadius: 4,
    paddingHorizontal: 14,
    paddingVertical: 10,
    maxWidth: "80%",
    borderWidth: 1,
    borderColor: C.border,
  },
  userText: {
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    color: C.text,
    lineHeight: 21,
  },
  aiRow: {
    alignItems: "flex-start",
    marginBottom: 20,
    paddingHorizontal: 16,
  },
  aiText: {
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    color: C.text,
    lineHeight: 22,
  },
});

// ─── Empty State ───────────────────────────────────────────────────────────────
const HINTS = [
  "Bagaimana kondisi market sekarang?",
  "Jelaskan sinyal aktif saat ini",
  "Apa itu Golden Zone di Fibonacci?",
];

function EmptyState({ onHint }: { onHint: (t: string) => void }) {
  return (
    <View style={emptyStyles.wrap}>
      <View style={emptyStyles.icon}>
        <Ionicons name="sparkles-outline" size={28} color={C.gold} />
      </View>
      <Text style={emptyStyles.title}>LIBARTIN AI</Text>
      <Text style={emptyStyles.sub}>
        Analisis pasar, sinyal, dan strategi XAUUSD — tanya apapun.
      </Text>
      <View style={emptyStyles.hints}>
        {HINTS.map((h) => (
          <Pressable
            key={h}
            style={({ pressed }) => [emptyStyles.chip, pressed && emptyStyles.chipPressed]}
            onPress={() => onHint(h)}
          >
            <Text style={emptyStyles.chipText}>{h}</Text>
            <Ionicons name="arrow-up-outline" size={13} color={C.textDim} style={{ marginLeft: 4 }} />
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const emptyStyles = StyleSheet.create({
  wrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 28,
    paddingBottom: 40,
    gap: 0,
  },
  icon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: C.goldBg,
    borderWidth: 1,
    borderColor: C.gold + "30",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
  },
  title: {
    fontFamily: "Orbitron_700Bold",
    fontSize: 16,
    color: C.text,
    letterSpacing: 2,
    marginBottom: 8,
  },
  sub: {
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    color: C.textSub,
    textAlign: "center",
    lineHeight: 20,
    marginBottom: 28,
  },
  hints: { gap: 8, alignSelf: "stretch" },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  chipPressed: {
    backgroundColor: "#1A2234",
    borderColor: C.gold + "44",
  },
  chipText: {
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    color: C.textSub,
    flex: 1,
  },
});

// ─── SSE Parser ────────────────────────────────────────────────────────────────
interface SSEParserState {
  lineBuffer: string;
  currentEvent: string;
}

function parseSSEChunk(
  raw: string,
  state: SSEParserState,
  handlers: {
    onThinkingToken: (token: string) => void;
    onThinking: (thinking: string) => void;
    onChunk: (chunk: string) => void;
    onError: (err: string) => void;
    onDone: () => void;
  }
) {
  state.lineBuffer += raw;
  const lines = state.lineBuffer.split("\n");
  state.lineBuffer = lines.pop() ?? "";

  for (const line of lines) {
    const trimmed = line.trimEnd();

    if (trimmed.startsWith("event: ")) {
      state.currentEvent = trimmed.slice(7).trim();
    } else if (trimmed.startsWith("data: ")) {
      const rawData = trimmed.slice(6);

      if (state.currentEvent === "thinking_token") {
        try {
          const parsed = JSON.parse(rawData) as { token?: string };
          if (parsed.token) handlers.onThinkingToken(parsed.token);
        } catch { /* ignore */ }

      } else if (state.currentEvent === "thinking") {
        try {
          const parsed = JSON.parse(rawData) as { thinking?: string };
          if (parsed.thinking) handlers.onThinking(parsed.thinking);
        } catch { /* ignore */ }

      } else if (state.currentEvent === "chunk") {
        try {
          const parsed = JSON.parse(rawData) as { chunk?: string };
          if (parsed.chunk) handlers.onChunk(parsed.chunk);
        } catch { /* ignore */ }

      } else if (state.currentEvent === "error") {
        try {
          const parsed = JSON.parse(rawData) as { error?: string };
          handlers.onError(parsed.error ?? "AI error");
        } catch {
          handlers.onError("AI mengalami error.");
        }

      } else if (state.currentEvent === "done") {
        handlers.onDone();
      }

      state.currentEvent = "";
    }
  }
}

// ─── Main Screen ───────────────────────────────────────────────────────────────
export default function AIScreen() {
  const insets = useSafeAreaInsets();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const flatListRef = useRef<FlatList>(null);
  const streamingIdRef = useRef<string | null>(null);
  const thinkingIdRef = useRef<string | null>(null);
  const thinkingStreamIdRef = useRef<string | null>(null);
  const inputRef = useRef<TextInput>(null);

  const scrollToBottom = useCallback(() => {
    setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 50);
  }, []);

  const clearChat = useCallback(() => {
    const doIt = () => {
      setMessages([]);
      if (BACKEND_URL) {
        fetch(`${BACKEND_URL}/api/ai/messages`, { method: "DELETE" }).catch(() => {});
      }
    };
    if (Platform.OS === "web") {
      doIt();
    } else {
      Alert.alert(
        "Hapus Percakapan",
        "Semua riwayat chat akan dihapus. Lanjutkan?",
        [
          { text: "Batal", style: "cancel" },
          { text: "Hapus", style: "destructive", onPress: doIt },
        ]
      );
    }
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

    const thinkingBubbleId = `think_${Date.now()}`;
    thinkingIdRef.current = thinkingBubbleId;
    const thinkingMsg: ChatMessage = {
      id: thinkingBubbleId,
      role: "assistant",
      content: "",
      thinkingPhase: true,
    };

    const thinkingStreamId = `tstream_${Date.now() + 1}`;
    thinkingStreamIdRef.current = thinkingStreamId;

    const msgId = `a_${Date.now() + 2}`;
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
      setMessages((prev) =>
        prev.filter((m) => m.id !== thinkingBubbleId && m.id !== thinkingStreamId)
      );
      setMessages((prev) => [
        ...prev,
        { id: msgId, role: "assistant", content: errMsg, streaming: false },
      ]);
      streamingIdRef.current = null;
      thinkingStreamIdRef.current = null;
      setIsStreaming(false);
    };

    let fullReceived = "";
    let thinkingReceived = "";
    let thinkingStreamShowing = false;
    let responseAdded = false;         // tracks if msgId bubble has been added — avoids stale-closure duplicates
    let sseState: SSEParserState = { lineBuffer: "", currentEvent: "" };
    let xhrDone = false;

    const handleDone = () => {
      if (xhrDone) return;
      xhrDone = true;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === msgId
            ? {
                ...m,
                content: fullReceived || m.content,
                streaming: false,
                thinking: thinkingReceived || undefined,
                streamingThinking: undefined,
                isThinkingStreaming: false,
              }
            : m.id === thinkingStreamId
            ? { ...m, isThinkingStreaming: false }
            : m
        )
      );
      setMessages((prev) =>
        prev.filter((m) => m.id !== thinkingBubbleId && m.id !== thinkingStreamId)
      );
      streamingIdRef.current = null;
      thinkingStreamIdRef.current = null;
      setIsStreaming(false);
    };

    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${BACKEND_URL}/api/ai/stream`, true);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.setRequestHeader("Accept", "text/event-stream");
    xhr.timeout = 120_000;

    let lastProcessedLength = 0;

    xhr.onprogress = () => {
      const newData = xhr.responseText.slice(lastProcessedLength);
      lastProcessedLength = xhr.responseText.length;
      if (!newData) return;

      parseSSEChunk(newData, sseState, {
        onThinkingToken: (token) => {
          thinkingReceived += token;

          if (!thinkingStreamShowing) {
            thinkingStreamShowing = true;
            setMessages((prev) =>
              prev.filter((m) => m.id !== thinkingBubbleId)
            );
            setMessages((prev) => [
              ...prev,
              {
                id: thinkingStreamId,
                role: "assistant",
                content: "",
                streamingThinking: token,
                isThinkingStreaming: true,
              },
            ]);
          } else {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === thinkingStreamId
                  ? { ...m, streamingThinking: thinkingReceived }
                  : m
              )
            );
          }
          scrollToBottom();
        },

        onThinking: (thinking) => {
          thinkingReceived = thinking;
          responseAdded = true;         // msgId bubble is being inserted here
          setMessages((prev) =>
            prev.filter((m) => m.id !== thinkingBubbleId && m.id !== thinkingStreamId)
          );
          setMessages((prev) => [
            ...prev,
            {
              id: msgId,
              role: "assistant",
              content: "",
              thinking,
              streaming: true,
            },
          ]);
          scrollToBottom();
        },

        onChunk: (chunk) => {
          fullReceived += chunk;

          if (!responseAdded) {
            // First chunk — remove placeholder bubbles and insert AI response bubble
            responseAdded = true;
            setMessages((prev) =>
              prev.filter((m) => m.id !== thinkingBubbleId && m.id !== thinkingStreamId)
            );
            setMessages((prev) => [
              ...prev,
              { id: msgId, role: "assistant", content: fullReceived, streaming: true },
            ]);
          } else {
            // Subsequent chunks — update content in place, never re-insert
            setMessages((prev) =>
              prev.map((m) =>
                m.id === msgId ? { ...m, content: fullReceived } : m
              )
            );
          }
          scrollToBottom();
        },

        onError: showError,
        onDone: () => {},
      });
    };

    xhr.onload = () => {
      const newData = xhr.responseText.slice(lastProcessedLength);
      if (newData) {
        parseSSEChunk(newData, sseState, {
          onThinkingToken: (token) => { thinkingReceived += token; },
          onThinking: (thinking) => { thinkingReceived = thinking; },
          onChunk: (chunk) => { fullReceived += chunk; },
          onError: showError,
          onDone: () => {},
        });
      }

      if (xhr.status < 200 || xhr.status >= 300) {
        let errMsg = "AI tidak dapat dijangkau. Coba lagi sebentar.";
        try {
          const parsed = JSON.parse(xhr.responseText) as { error?: string };
          if (parsed.error) errMsg = parsed.error;
        } catch { /* ignore */ }
        showError(errMsg);
        return;
      }

      handleDone();
    };

    xhr.onerror = () => {
      if (!xhrDone) {
        xhrDone = true;
        showError("Koneksi ke server gagal. Coba lagi dalam beberapa detik.");
      }
    };

    xhr.ontimeout = () => {
      if (!xhrDone) {
        xhrDone = true;
        showError("AI memerlukan waktu terlalu lama. Coba lagi sebentar.");
      }
    };

    xhr.send(JSON.stringify({ message: text }));
  }, [input, isStreaming, scrollToBottom]);

  const handleHint = useCallback((hint: string) => {
    setInput(hint);
    setTimeout(() => inputRef.current?.focus(), 100);
  }, []);

  const tabBarHeight = Platform.OS === "web" ? 84 : 60;

  return (
    <View style={[S.root, { paddingTop: insets.top, paddingBottom: tabBarHeight + insets.bottom }]}>

      {/* Header */}
      <View style={S.header}>
        <View style={S.headerCenter}>
          <Text style={S.headerTitle}>LIBARTIN AI</Text>
          <View style={S.thinkingBadge}>
            <View style={S.thinkingDot} />
            <Text style={S.thinkingLabel}>Thinking</Text>
          </View>
        </View>
        {messages.length > 0 && (
          <Pressable onPress={clearChat} style={S.clearBtn} hitSlop={12}>
            <Ionicons name="trash-outline" size={18} color={C.textDim} />
          </Pressable>
        )}
      </View>

      {/* Divider */}
      <View style={S.divider} />

      {/* Messages */}
      <View style={S.flex}>
        {messages.length === 0 ? (
          <EmptyState onHint={handleHint} />
        ) : (
          <FlatList
            ref={flatListRef}
            data={messages}
            keyExtractor={(m) => m.id}
            renderItem={({ item }) => <MessageRow msg={item} />}
            contentContainerStyle={S.listContent}
            onContentSizeChange={scrollToBottom}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            style={S.flex}
          />
        )}
      </View>

      {/* Input Bar */}
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : Platform.OS === "web" ? undefined : "height"}
      >
        <View style={S.inputBar}>
          <View style={S.inputRow}>
            <TextInput
              ref={inputRef}
              style={S.input}
              value={input}
              onChangeText={setInput}
              placeholder="Tanya tentang XAUUSD..."
              placeholderTextColor={C.textDim}
              multiline
              maxLength={500}
              onSubmitEditing={sendMessage}
              editable={!isStreaming}
              returnKeyType="send"
              blurOnSubmit={false}
              autoFocus={false}
              textAlignVertical="center"
            />
            <Pressable
              style={[S.sendBtn, (!input.trim() || isStreaming) && S.sendBtnOff]}
              onPress={sendMessage}
              disabled={!input.trim() || isStreaming}
            >
              {isStreaming ? (
                <ActivityIndicator size="small" color={C.textDim} />
              ) : (
                <Ionicons
                  name="arrow-up"
                  size={18}
                  color={input.trim() ? C.bg : C.textDim}
                />
              )}
            </Pressable>
          </View>
          <Text style={S.inputFooter}>XAUUSD · Fibonacci Scalping Strategy</Text>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const S = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: C.bg,
  },
  flex: { flex: 1 },

  // Header
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
    paddingVertical: 13,
    position: "relative",
  },
  headerCenter: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  headerTitle: {
    fontFamily: "Orbitron_700Bold",
    fontSize: 14,
    color: C.text,
    letterSpacing: 2,
  },
  thinkingBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 20,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  thinkingDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: C.gold,
  },
  thinkingLabel: {
    fontFamily: "Inter_400Regular",
    fontSize: 10,
    color: C.textSub,
    letterSpacing: 0.3,
  },
  clearBtn: {
    position: "absolute",
    right: 16,
    top: 0,
    bottom: 0,
    justifyContent: "center",
    padding: 4,
  },

  divider: {
    height: 1,
    backgroundColor: C.border,
  },

  // List
  listContent: {
    paddingTop: 20,
    paddingBottom: 8,
  },

  // Input
  inputBar: {
    paddingTop: 10,
    paddingHorizontal: 14,
    paddingBottom: 8,
    borderTopWidth: 1,
    borderTopColor: C.border,
    backgroundColor: C.bg,
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
  },
  input: {
    flex: 1,
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 10,
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    color: C.text,
    maxHeight: 120,
    minHeight: 44,
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: C.gold,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  sendBtnOff: {
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
  },
  inputFooter: {
    fontFamily: "Inter_400Regular",
    fontSize: 10,
    color: C.textDim,
    textAlign: "center",
    marginTop: 6,
    letterSpacing: 0.3,
  },
});
