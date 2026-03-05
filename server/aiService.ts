import https from "https";
import type { TradingSignal, MarketStateSnapshot } from "./derivService";

const AI_HOSTNAME = "text.pollinations.ai";
const AI_PATH = "/v1/chat/completions";

export interface AIMessage {
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
    requestId?: string;
  };
}

interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

// ─── Strip Markdown ────────────────────────────────────────────────────────────
function stripMarkdown(text: string): string {
  return text
    .replace(/#{1,6}\s+/g, "")
    .replace(/\*\*\*(.+?)\*\*\*/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/_(.+?)_/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`{3}[\s\S]*?`{3}/g, "")
    .replace(/`(.+?)`/g, "$1")
    .replace(/\[(.+?)\]\(.+?\)/g, "$1")
    .replace(/!\[.*?\]\(.+?\)/g, "")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^\d+\.\s+/gm, "")
    .replace(/^>{1,}\s*/gm, "")
    .replace(/^-{3,}$/gm, "")
    .replace(/^\*{3,}$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ─── System Prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Kamu adalah LIBARTIN AI, asisten analisis trading emas XAUUSD yang tertanam langsung di dalam aplikasi LIBARTIN.

IDENTITAS:
Nama: LIBARTIN AI yang dikembangkan oleh Dzeck x Wakassim
Spesialisasi: Analisis XAUUSD real-time menggunakan strategi Fibonacci Retracement dan EMA Crossover
Bahasa: Indonesia. Boleh campur istilah teknis Inggris yang lazim di dunia trading, lebih fokus ke bahasa Indonesia 
Karakter: Lugas, informatif, tidak bertele-tele. Tidak pernah mengarang data.

STRUKTUR APLIKASI LIBARTIN:
Aplikasi ini punya 4 tab utama yang selalu tersedia di bagian bawah layar.

Tab 1 - Dashboard: Menampilkan harga XAUUSD live, status koneksi ke Deriv (LIVE/OFFLINE), status pasar (buka/tutup), trend M15 saat ini, nilai EMA50 dan EMA200, jumlah candle M15 dan M5 yang sudah dikumpulkan, level Fibonacci lengkap (Swing High, Golden Zone 61.8%, Deep 78.6%, Swing Low, TP Extension -27%), indikator apakah harga sedang di dalam Golden Zone, serta sinyal aktif jika ada. Ada juga visualisasi chart Fibonacci.

Tab 2 - Sinyal: Menampilkan riwayat semua sinyal yang pernah dihasilkan sistem, termasuk arah (BUY/SELL), harga entry, SL, TP1, TP2, konfirmasi pola candlestick, dan status outcome (WIN, LOSS, atau PENDING). Di bagian atas ada statistik win rate dan distribusi hasil trade.

Tab 3 - AI Chat (tab ini): Tempat pengguna bicara dengan kamu. Kamu bisa menjawab pertanyaan tentang kondisi pasar, strategi, sinyal yang sedang aktif, atau konsep trading umum. Kamu punya akses ke semua data pasar real-time yang dikirim bersama setiap pesan.

Tab 4 - Settings: Pengaturan aplikasi termasuk preferensi notifikasi dan konfigurasi pengguna.

STRATEGI SINYAL LIBARTIN:
Timeframe analisis: M15 untuk trend dan struktur Fibonacci, M5 untuk konfirmasi entry.
Trend Bullish: Harga di atas EMA200 DAN EMA50 di atas EMA200 pada M15.
Trend Bearish: Harga di bawah EMA200 DAN EMA50 di bawah EMA200 pada M15.
Fibonacci anchor: Fractal 5-bar tertua yang valid pada M15.
Golden Zone: Retracement 61.8% sampai 78.6% dari swing (zona entry utama).
Konfirmasi entry M5 (TIGA syarat wajib terpenuhi bersamaan):
1. Harga berada di dalam Golden Zone (61.8% - 78.6%).
2. Pola candlestick konfirmasi: Pin Bar Rejection atau Engulfing Bullish/Bearish pada M5.
3. EMA alignment M5: EMA20 > EMA50 untuk konfirmasi Bullish. EMA20 < EMA50 untuk konfirmasi Bearish.
Stop Loss Bullish: Di bawah Swing Low fractal. Stop Loss Bearish: Di atas Swing High fractal.
TP1 (Scalping): Risk-Reward 1:1 dari SL, maksimal 15 poin dari entry. Untuk ambil profit cepat.
TP2 (Full Target): Fibonacci extension -27% atau RR 1:1.8, cap 28 poin dari entry. Target optimal jika momentum kuat.
Aturan satu posisi: Hanya satu sinyal aktif per anchor fractal. Sinyal baru hanya muncul jika fractal berubah.

CARA MENJAWAB PERTANYAAN PENGGUNA:
Jika pengguna tanya kondisi pasar: gunakan data real-time yang dikirim bersama pesannya (harga, trend, EMA, Fibonacci, sinyal aktif).
Jika pengguna tanya riwayat sinyal atau win rate: arahkan ke tab Sinyal karena kamu tidak punya akses ke data historis sinyal.
Jika pengguna tanya cara baca chart atau konsep trading: jelaskan secara praktis sesuai konteks aplikasi LIBARTIN.
Jika pengguna tanya apakah harus BUY atau SELL sekarang: lihat data sinyal aktif yang dikirim. Jika tidak ada sinyal aktif, katakan sistem belum mendeteksi setup valid dan jelaskan kondisi saat ini.
Jika pengguna tanya tentang tab atau fitur aplikasi: jelaskan berdasarkan struktur aplikasi di atas.

ATURAN KETAT:
Jangan pernah mengarang harga, level EMA, level Fibonacci, atau data apapun yang tidak ada dalam konteks.
Jangan berikan rekomendasi entry jika tidak ada sinyal aktif dari sistem.
Jangan janjikan profit atau pastikan hasil trade apapun. Selalu ingatkan bahwa trading mengandung risiko.
Ingat percakapan sebelumnya dalam sesi ini dan jadikan referensi jika relevan.

FORMAT RESPONS WAJIB:
Tulis dalam teks biasa yang mengalir. Jangan gunakan markdown, bintang, tanda pagar, garis bawah, backtick, atau dash sebagai bullet point. Gunakan angka 1, 2, 3 jika perlu urutan langkah. Untuk rekomendasi sinyal maksimal 180 kata. Untuk penjelasan konsep boleh lebih panjang tapi tetap padat dan tidak bertele-tele.`;

// ─── Call AI API (https native, with retry) ───────────────────────────────────
function callPollinationsAI(
  messages: Array<{ role: string; content: string }>,
  attempt = 0
): Promise<string> {
  const payload = JSON.stringify({
    model: "openai",
    stream: false,
    messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
  });

  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: AI_HOSTNAME,
        path: AI_PATH,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          "User-Agent": "Mozilla/5.0 LIBARTIN-Trading-App",
          "Accept": "application/json",
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => { raw += chunk; });
        res.on("end", async () => {
          const status = res.statusCode ?? 0;
          if (status >= 400) {
            console.error(`[AIService] HTTP ${status}: ${raw.slice(0, 200)}`);
            if (attempt === 0) {
              console.log("[AIService] Retrying after HTTP error...");
              await new Promise((r) => setTimeout(r, 3000));
              resolve(callPollinationsAI(messages, 1));
            } else {
              resolve("");
            }
            return;
          }
          try {
            const result = JSON.parse(raw) as {
              choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
            };
            const msg = result?.choices?.[0]?.message;
            const content = msg?.content ?? msg?.reasoning_content ?? "";
            if (!content && attempt === 0) {
              console.warn("[AIService] Empty content, retrying...");
              await new Promise((r) => setTimeout(r, 2000));
              resolve(callPollinationsAI(messages, 1));
              return;
            }
            resolve(stripMarkdown(content.trim()));
          } catch (parseErr) {
            console.error("[AIService] Parse error:", raw.slice(0, 200));
            if (attempt === 0) {
              await new Promise((r) => setTimeout(r, 2000));
              resolve(callPollinationsAI(messages, 1));
            } else {
              resolve("");
            }
          }
        });
      }
    );

    req.on("error", async (e) => {
      console.error("[AIService] Request error:", e.message);
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 2000));
        resolve(callPollinationsAI(messages, 1));
      } else {
        resolve("");
      }
    });

    // 35s per attempt — keeps total (retry included) well within frontend's 80s timeout
    req.setTimeout(35000, () => {
      console.error("[AIService] Request timeout (35s)");
      req.destroy();
      // Do NOT retry on timeout — fail fast so frontend doesn't abort first
      resolve("");
    });

    req.write(payload);
    req.end();
  });
}

// ─── Server-side word streaming (simulate streaming from full response) ──────────
function streamWordByWord(
  text: string,
  onChunk: (chunk: string) => void,
  onDone: () => void
): void {
  const tokens: string[] = [];
  const re = /(\S+\s*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) tokens.push(m[1]);

  if (tokens.length === 0) {
    onDone();
    return;
  }

  let i = 0;
  const ms = Math.max(25, Math.min(80, Math.floor(2000 / tokens.length)));

  const iv = setInterval(() => {
    if (i < tokens.length) {
      onChunk(tokens[i]);
      i++;
    } else {
      clearInterval(iv);
      onDone();
    }
  }, ms);
}

// ─── Market Context Builder ───────────────────────────────────────────────────
function buildMarketContext(snapshot: MarketStateSnapshot): string {
  const p = snapshot.currentPrice;
  const fib = snapshot.fibLevels;

  const trendLabel = snapshot.trend === "Bullish"
    ? "Bullish (Harga > EMA200, EMA50 > EMA200)"
    : snapshot.trend === "Bearish"
    ? "Bearish (Harga < EMA200, EMA50 < EMA200)"
    : snapshot.trend === "No Trade"
    ? "No Trade (EMA tidak selaras)"
    : "Loading";

  const m5EmaStatus = (() => {
    const e20 = snapshot.ema20m5;
    const e50 = snapshot.ema50m5;
    if (e20 === null || e50 === null) return "Belum cukup candle M5";
    if (e20 > e50) return `Bullish (EMA20 ${e20.toFixed(2)} > EMA50 ${e50.toFixed(2)})`;
    if (e20 < e50) return `Bearish (EMA20 ${e20.toFixed(2)} < EMA50 ${e50.toFixed(2)})`;
    return `Netral (EMA20 = EMA50 = ${e20.toFixed(2)})`;
  })();

  const lines: string[] = [
    `[DATA PASAR REAL-TIME — LIBARTIN]`,
    `Waktu: ${new Date().toUTCString()}`,
    `Harga XAUUSD: ${p !== null ? p.toFixed(2) : "Belum tersedia"}`,
    `Status Pasar: ${snapshot.marketOpen ? "Buka" : "Tutup"}`,
    `Koneksi Deriv: ${snapshot.connectionStatus}`,
    ``,
    `[ANALISIS TEKNIKAL M15 — Trend & Struktur]`,
    `Trend M15: ${trendLabel}`,
    `EMA50 (M15): ${snapshot.ema50 !== null ? snapshot.ema50.toFixed(2) : "N/A"}`,
    `EMA200 (M15): ${snapshot.ema200 !== null ? snapshot.ema200.toFixed(2) : "N/A"}`,
    `Candle M15 terkumpul: ${snapshot.m15CandleCount}`,
    ``,
    `[ANALISIS TEKNIKAL M5 — Konfirmasi Entry]`,
    `EMA20 (M5): ${snapshot.ema20m5 !== null ? snapshot.ema20m5.toFixed(2) : "N/A"}`,
    `EMA50 (M5): ${snapshot.ema50m5 !== null ? snapshot.ema50m5.toFixed(2) : "N/A"}`,
    `EMA Alignment M5: ${m5EmaStatus}`,
    `Candle M5 terkumpul: ${snapshot.m5CandleCount}`,
    `Harga di Golden Zone (61.8-78.6%): ${snapshot.inZone ? "YA — harga dalam zona entry" : "TIDAK"}`,
  ];

  if (fib) {
    lines.push(
      ``,
      `[FIBONACCI LEVELS (M15 Swing)]`,
      `Swing High (anchor atas): ${fib.swingHigh.toFixed(2)}`,
      `Golden 61.8% (zona entry): ${fib.level618.toFixed(2)}`,
      `Deep 78.6% (zona entry dalam): ${fib.level786.toFixed(2)}`,
      `Swing Low (anchor bawah): ${fib.swingLow.toFixed(2)}`,
      `Extension -27% (target TP): ${fib.extensionNeg27.toFixed(2)}`
    );
  } else {
    lines.push(``, `[FIBONACCI]: Belum ada struktur swing valid yang terdeteksi pada M15`);
  }

  if (snapshot.currentSignal) {
    const sig = snapshot.currentSignal;
    const dir = sig.trend === "Bullish" ? "BUY" : "SELL";
    const konfirmasi = sig.confirmationType === "engulfing" ? "Engulfing M5" : "Pin Bar Rejection M5";
    lines.push(
      ``,
      `[SINYAL AKTIF]`,
      `Arah: ${dir}`,
      `Entry: ${sig.entryPrice.toFixed(2)}`,
      `Stop Loss: ${sig.stopLoss.toFixed(2)}`,
      `TP1 Scalping: ${sig.takeProfit.toFixed(2)} (RR 1:${sig.riskReward})`,
      ...(sig.takeProfit2
        ? [`TP2 Full Target: ${sig.takeProfit2.toFixed(2)} (RR 1:${sig.riskReward2})`]
        : []),
      `Konfirmasi: ${konfirmasi}`,
      `Waktu sinyal: ${sig.timestampUTC}`
    );
  } else {
    lines.push(``, `[SINYAL]: Tidak ada sinyal aktif saat ini — sistem belum mendeteksi setup valid`);
  }

  return lines.join("\n");
}

// ─── AI Service ────────────────────────────────────────────────────────────────
class AIService {
  private displayMessages: AIMessage[] = [];
  private conversationHistory: ConversationTurn[] = [];
  private isGenerating = false;
  private lastSignalId: string | null = null;

  private readonly MAX_HISTORY_TURNS = 6;
  private readonly MAX_DISPLAY_MESSAGES = 60;

  private addDisplayMessage(msg: Omit<AIMessage, "id" | "timestamp">): AIMessage {
    const full: AIMessage = {
      ...msg,
      id: `ai_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toUTCString(),
    };
    this.displayMessages.unshift(full);
    if (this.displayMessages.length > this.MAX_DISPLAY_MESSAGES) {
      this.displayMessages.pop();
    }
    return full;
  }

  private addToHistory(role: "user" | "assistant", content: string): void {
    this.conversationHistory.push({ role, content });
    const maxEntries = this.MAX_HISTORY_TURNS * 2;
    if (this.conversationHistory.length > maxEntries) {
      this.conversationHistory.splice(0, this.conversationHistory.length - maxEntries);
    }
  }

  private buildMessagesWithHistory(userMsg: string): Array<{ role: string; content: string }> {
    const history = this.conversationHistory.map((t) => ({
      role: t.role,
      content: t.content,
    }));
    return [...history, { role: "user", content: userMsg }];
  }

  // ─── Signal Recommendation (auto-triggered, no history needed) ──────────────
  async generateSignalRecommendation(
    signal: TradingSignal,
    snapshot: MarketStateSnapshot
  ): Promise<void> {
    if (this.isGenerating) return;
    if (this.lastSignalId === signal.id) return;
    this.lastSignalId = signal.id;
    this.isGenerating = true;

    const direction = signal.trend === "Bullish" ? "BUY" : "SELL";
    const confirmLabel =
      signal.confirmationType === "engulfing" ? "Engulfing M5" : "Pin Bar Rejection M5";

    const marketCtx = buildMarketContext(snapshot);
    const tp2Info = signal.takeProfit2
      ? ` | TP2: ${signal.takeProfit2.toFixed(2)} (RR 1:${signal.riskReward2})`
      : "";
    const userMsg =
      `${marketCtx}\n\n` +
      `SINYAL BARU TERDETEKSI: ${direction} XAUUSD\n` +
      `Entry: ${signal.entryPrice.toFixed(2)} | SL: ${signal.stopLoss.toFixed(2)}\n` +
      `TP1: ${signal.takeProfit.toFixed(2)} (RR 1:${signal.riskReward})${tp2Info}\n` +
      `Konfirmasi: ${confirmLabel}\n\n` +
      `Berikan analisis singkat dan rekomendasi untuk sinyal ini. Jelaskan alasan teknikal berdasarkan data di atas. ` +
      `Sebutkan level Entry, SL, TP1 (scalping cepat), dan TP2 (full target). Ingatkan bahwa ini sinyal teknikal bukan jaminan profit. Tulis dalam teks biasa tanpa format apapun.`;

    console.log(`[AIService] Generating signal recommendation: ${direction} @ ${signal.entryPrice}`);

    const response = await callPollinationsAI([{ role: "user", content: userMsg }]);
    this.isGenerating = false;

    if (!response) {
      console.warn("[AIService] Empty response for signal recommendation");
      return;
    }

    const clean = stripMarkdown(response);

    this.addToHistory("user", userMsg);
    this.addToHistory("assistant", clean);

    this.addDisplayMessage({
      role: "assistant",
      content: clean,
      type: "signal",
      metadata: {
        signalId: signal.id,
        trend: signal.trend,
        entryPrice: signal.entryPrice,
      },
    });

    console.log(`[AIService] Signal recommendation done (${clean.length} chars)`);
  }

  // ─── Outcome Commentary (auto-triggered on TP/SL) ──────────────────────────
  async generateOutcomeCommentary(
    signal: TradingSignal,
    outcome: "win" | "loss",
    snapshot: MarketStateSnapshot
  ): Promise<void> {
    if (this.isGenerating) return;
    this.isGenerating = true;

    const direction = signal.trend === "Bullish" ? "BUY" : "SELL";
    const outcomeLabel = outcome === "win" ? "TP TERCAPAI WIN" : "SL TERCAPAI LOSS";
    const marketCtx = buildMarketContext(snapshot);

    const userMsg =
      `${marketCtx}\n\n` +
      `HASIL TRADE: ${outcomeLabel}\n` +
      `Arah: ${direction} XAUUSD\n` +
      `Entry: ${signal.entryPrice.toFixed(2)} | SL: ${signal.stopLoss.toFixed(2)} | TP: ${signal.takeProfit.toFixed(2)}\n\n` +
      (outcome === "win"
        ? `TP berhasil dicapai. Berikan komentar singkat, sebutkan level yang berhasil dan dorong untuk tetap disiplin pada strategi. Tulis teks biasa tanpa format.`
        : `SL tercapai. Berikan komentar singkat. Ingatkan bahwa loss adalah bagian normal dari trading dan disiplin SL melindungi akun. Tulis teks biasa tanpa format.`);

    console.log(`[AIService] Generating outcome commentary: ${outcomeLabel}`);

    const response = await callPollinationsAI(
      this.buildMessagesWithHistory(userMsg)
    );
    this.isGenerating = false;

    if (!response) {
      console.warn("[AIService] Empty response for outcome commentary");
      return;
    }

    const clean = stripMarkdown(response);

    this.addToHistory("user", userMsg);
    this.addToHistory("assistant", clean);

    this.addDisplayMessage({
      role: "assistant",
      content: clean,
      type: "outcome",
      metadata: {
        signalId: signal.id,
        trend: signal.trend,
        outcome,
        entryPrice: signal.entryPrice,
      },
    });

    console.log(`[AIService] Outcome commentary done`);
  }

  // ─── User Chat (non-streaming) ─────────────────────────────────────────────
  async chat(
    userMessage: string,
    snapshot: MarketStateSnapshot,
    requestId?: string
  ): Promise<string> {
    const marketCtx = buildMarketContext(snapshot);
    const messages: Array<{ role: string; content: string }> = [];
    const recentHistory = this.conversationHistory.slice(-6);

    if (recentHistory.length === 0) {
      messages.push({
        role: "user",
        content: `${marketCtx}\n\nPertanyaan: ${userMessage}`,
      });
    } else {
      messages.push({
        role: "user",
        content: `${marketCtx}\n\nPertanyaan sebelumnya: ${recentHistory[0].content}`,
      });
      for (let i = 1; i < recentHistory.length; i++) {
        messages.push({ role: recentHistory[i].role, content: recentHistory[i].content });
      }
      messages.push({ role: "user", content: userMessage });
    }

    const response = await callPollinationsAI(messages);

    // Always pick a final reply — never leave displayMessages empty after a chat
    const clean = response
      ? stripMarkdown(response)
      : "Maaf, AI tidak dapat merespons saat ini. Silakan coba lagi sebentar.";

    this.addToHistory("user", userMessage);
    this.addToHistory("assistant", clean);

    // CRITICAL: always add both messages so the frontend poll can find the response
    this.addDisplayMessage({ role: "user", content: userMessage, type: "user_chat" });
    this.addDisplayMessage({
      role: "assistant",
      content: clean,
      type: "user_chat",
      ...(requestId ? { metadata: { requestId } } : {}),
    });

    return clean;
  }

  // ─── User Chat Streaming ───────────────────────────────────────────────────
  chatStream(
    userMessage: string,
    snapshot: MarketStateSnapshot,
    onChunk: (chunk: string) => void,
    onDone: (fullResponse: string) => void,
    onError: (err: string) => void
  ): void {
    const marketCtx = buildMarketContext(snapshot);
    const messages: Array<{ role: string; content: string }> = [];
    const recentHistory = this.conversationHistory.slice(-6);

    if (recentHistory.length === 0) {
      messages.push({
        role: "user",
        content: `${marketCtx}\n\nPertanyaan: ${userMessage}`,
      });
    } else {
      messages.push({
        role: "user",
        content: `${marketCtx}\n\nPertanyaan sebelumnya: ${recentHistory[0].content}`,
      });
      for (let i = 1; i < recentHistory.length; i++) {
        messages.push({ role: recentHistory[i].role, content: recentHistory[i].content });
      }
      messages.push({ role: "user", content: userMessage });
    }

    callPollinationsAI(messages).then((fullResponse) => {
      const clean = fullResponse.trim() || "Maaf, AI tidak dapat merespons saat ini.";

      this.addToHistory("user", userMessage);
      this.addToHistory("assistant", clean);
      this.addDisplayMessage({ role: "user", content: userMessage, type: "user_chat" });
      this.addDisplayMessage({ role: "assistant", content: clean, type: "user_chat" });

      streamWordByWord(clean, onChunk, () => onDone(clean));
    }).catch((err: Error) => {
      onError(err.message || "AI error");
    });
  }

  getMessages(limit = 20): AIMessage[] {
    return this.displayMessages.slice(0, limit);
  }

  isReady(): boolean {
    return !this.isGenerating;
  }

  getHistoryLength(): number {
    return this.conversationHistory.length;
  }
}

export const aiService = new AIService();
