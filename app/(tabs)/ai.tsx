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
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import C from "@/constants/colors";

// ─── Backend URL ───────────────────────────────────────────────────────────────
function getBackendUrl(): string {
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
  streaming?: boolean;
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

// ─── Message Bubble ────────────────────────────────────────────────────────────
function MessageBubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === "user";

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
    marginBottom: 24,
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

    const streamId = `a_${Date.now()}`;
    streamingIdRef.current = streamId;

    const placeholderMsg: ChatMessage = {
      id: streamId,
      role: "assistant",
      content: "",
      streaming: true,
    };

    setMessages((prev) => [...prev, userMsg, placeholderMsg]);
    setIsStreaming(true);
    scrollToBottom();

    if (!BACKEND_URL) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === streamId
            ? { ...m, content: "Backend tidak tersambung. Pastikan server berjalan.", streaming: false }
            : m
        )
      );
      setIsStreaming(false);
      return;
    }

    try {
      const response = await fetch(`${BACKEND_URL}/api/ai/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("ReadableStream tidak tersedia");

      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      let accumulated = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;
          const data = trimmed.slice(6);

          if (data === "[DONE]") {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === streamId ? { ...m, streaming: false } : m
              )
            );
            setIsStreaming(false);
            scrollToBottom();
            return;
          }

          try {
            const parsed = JSON.parse(data);
            if (parsed.error) {
              throw new Error(parsed.error);
            }
            if (parsed.chunk) {
              accumulated += parsed.chunk;
              const current = accumulated;
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === streamId ? { ...m, content: current, streaming: true } : m
                )
              );
              scrollToBottom();
            }
          } catch (parseErr) {
            // skip malformed chunk
          }
        }
      }

      setMessages((prev) =>
        prev.map((m) => (m.id === streamId ? { ...m, streaming: false } : m))
      );
    } catch (err: unknown) {
      const errMsg =
        err instanceof Error ? err.message : "Terjadi kesalahan. Coba lagi.";
      setMessages((prev) =>
        prev.map((m) =>
          m.id === streamId
            ? {
                ...m,
                content: `Gagal menghubungi AI: ${errMsg}`,
                streaming: false,
              }
            : m
        )
      );
    } finally {
      setIsStreaming(false);
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
          <Text style={styles.headerTitle}>LIBARTIN AI</Text>
        </View>
        <Text style={styles.headerSub}>XAUUSD Trading Advisor</Text>
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
          {isStreaming && (
            <View style={styles.thinkingBar}>
              <ActivityIndicator size="small" color={C.gold} />
              <Text style={styles.thinkingText}>AI sedang memproses...</Text>
            </View>
          )}
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
  headerSub: {
    fontFamily: "Inter_400Regular",
    fontSize: 11,
    color: C.textSub,
  },
  listContent: {
    paddingTop: 16,
    paddingBottom: 8,
  },
  thinkingBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  thinkingText: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    color: C.gold,
    opacity: 0.8,
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
