import https from "https";
import type { TradingSignal, MarketStateSnapshot } from "./derivService";

const AI_API_URL = "text.pollinations.ai";
const AI_API_PATH = "/v1/chat/completions";

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
  };
}

interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

// ─── Strip Markdown ────────────────────────────────────────────────────────────
// Hapus semua karakter markdown: bintang, garis, hashtag, backtick, dll
function stripMarkdown(text: string): string {
  return text
    .replace(/#{1,6}\s+/g, "")           // # Heading
    .replace(/\*\*\*(.+?)\*\*\*/g, "$1") // ***bold italic***
    .replace(/\*\*(.+?)\*\*/g, "$1")     // **bold**
    .replace(/\*(.+?)\*/g, "$1")         // *italic*
    .replace(/__(.+?)__/g, "$1")         // __bold__
    .replace(/_(.+?)_/g, "$1")           // _italic_
    .replace(/~~(.+?)~~/g, "$1")         // ~~strikethrough~~
    .replace(/`{3}[\s\S]*?`{3}/g, "")   // ```code block```
    .replace(/`(.+?)`/g, "$1")           // `inline code`
    .replace(/\[(.+?)\]\(.+?\)/g, "$1") // [text](url)
    .replace(/!\[.*?\]\(.+?\)/g, "")    // ![image](url)
    .replace(/^[-*+]\s+/gm, "")         // - bullet or * bullet
    .replace(/^\d+\.\s+/gm, "")         // 1. numbered list
    .replace(/^>{1,}\s*/gm, "")         // > blockquote
    .replace(/^-{3,}$/gm, "")           // --- horizontal rule
    .replace(/^\*{3,}$/gm, "")          // *** horizontal rule
    .replace(/\n{3,}/g, "\n\n")         // multiple blank lines → max 2
    .trim();
}

// ─── System Prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Kamu adalah LIBARTIN AI, asisten analisis trading emas XAUUSD yang terintegrasi penuh dengan aplikasi LIBARTIN.

IDENTITAS:
Nama: LIBARTIN AI
Spesialisasi: Analisis XAUUSD menggunakan strategi Fibonacci Retracement dan EMA Crossover pada timeframe M15 dan M5
Bahasa: Indonesia, boleh campur istilah teknis Inggris yang lazim

STRATEGI APLIKASI:
Trend M15: Bullish jika harga di atas EMA200 dan EMA50 di atas EMA200. Bearish jika sebaliknya.
Fibonacci: Anchor adalah fractal 5-bar tertua. Golden Zone adalah 61.8 persen sampai 78.6 persen retracement.
Konfirmasi entry M5: Pin Bar (Rejection) atau Engulfing di dalam zona Fibonacci.
Stop Loss: Swing Low untuk Bullish, Swing High untuk Bearish.
Take Profit: Extension minus 27 persen dari swing range.
Single Position Rule: Hanya 1 sinyal per anchor fractal.

ATURAN KETAT:
Jangan pernah mengarang atau menebak harga, level EMA, atau level Fibonacci.
Jangan beri rekomendasi beli atau jual jika tidak ada sinyal aktif dari sistem.
Jangan janjikan profit atau pastikan hasil trade apapun.
Semua analisis harus berdasarkan data nyata yang dikirimkan dalam percakapan.
Kamu boleh mengingat dan merujuk percakapan sebelumnya dalam sesi ini.

FORMAT RESPONS WAJIB:
Tulis dalam teks biasa saja. Jangan gunakan markdown, jangan pakai bintang, jangan pakai tanda pagar, jangan pakai garis bawah, jangan pakai backtick, jangan pakai dash sebagai bullet. Gunakan kalimat biasa yang mengalir. Boleh gunakan angka 1, 2, 3 jika perlu urutan. Maksimal 150 kata untuk rekomendasi sinyal.`;

// ─── Call AI API ───────────────────────────────────────────────────────────────
async function callPollinationsAI(
  messages: Array<{ role: string; content: string }>
): Promise<string> {
  const payload = JSON.stringify({
    model: "openai",
    messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
  });

  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: AI_API_URL,
        path: AI_API_PATH,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => { raw += chunk; });
        res.on("end", () => {
          try {
            const result = JSON.parse(raw);
            const content = result?.choices?.[0]?.message?.content ?? "";
            resolve(stripMarkdown(content.trim()));
          } catch {
            console.error("[AIService] Parse error:", raw.slice(0, 200));
            resolve("");
          }
        });
      }
    );
    req.on("error", (e) => {
      console.error("[AIService] Request error:", e.message);
      resolve("");
    });
    req.setTimeout(35000, () => {
      console.error("[AIService] Request timeout");
      req.destroy();
      resolve("");
    });
    req.write(payload);
    req.end();
  });
}

// ─── Market Context Builder ───────────────────────────────────────────────────
function buildMarketContext(snapshot: MarketStateSnapshot): string {
  const p = snapshot.currentPrice;
  const fib = snapshot.fibLevels;
  const lines: string[] = [
    `[DATA PASAR REAL-TIME]`,
    `Waktu: ${new Date().toUTCString()}`,
    `Harga XAUUSD: ${p !== null ? p.toFixed(2) : "Memuat..."}`,
    `Trend M15: ${snapshot.trend}`,
    `EMA50: ${snapshot.ema50 !== null ? snapshot.ema50.toFixed(2) : "N/A"}`,
    `EMA200: ${snapshot.ema200 !== null ? snapshot.ema200.toFixed(2) : "N/A"}`,
    `Harga di Golden Zone 61.8-78.6 persen: ${snapshot.inZone ? "YA" : "TIDAK"}`,
    `Pasar: ${snapshot.marketOpen ? "Buka" : "Tutup"}`,
    `Koneksi ke Deriv: ${snapshot.connectionStatus}`,
  ];

  if (fib) {
    lines.push(
      `[FIBONACCI LEVELS]`,
      `Swing High: ${fib.swingHigh.toFixed(2)}`,
      `61.8 persen Golden: ${fib.level618.toFixed(2)}`,
      `78.6 persen Deep: ${fib.level786.toFixed(2)}`,
      `Swing Low: ${fib.swingLow.toFixed(2)}`,
      `Minus 27 persen Extension TP: ${fib.extensionNeg27.toFixed(2)}`
    );
  } else {
    lines.push(`[FIBONACCI]: Belum ada struktur swing yang terdeteksi`);
  }

  if (snapshot.currentSignal) {
    const sig = snapshot.currentSignal;
    lines.push(
      `[SINYAL AKTIF]`,
      `Arah: ${sig.trend === "Bullish" ? "BUY" : "SELL"}`,
      `Entry: ${sig.entryPrice.toFixed(2)}`,
      `Stop Loss: ${sig.stopLoss.toFixed(2)}`,
      `Take Profit: ${sig.takeProfit.toFixed(2)}`,
      `Risk Reward: 1 banding ${sig.riskReward}`,
      `Konfirmasi: ${sig.confirmationType === "engulfing" ? "Engulfing M5" : "Pin Bar Rejection M5"}`,
      `Waktu Sinyal: ${sig.timestampUTC}`
    );
  } else {
    lines.push(`[SINYAL]: Tidak ada sinyal aktif saat ini`);
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
    const userMsg =
      `${marketCtx}\n\n` +
      `SINYAL BARU TERDETEKSI: ${direction} XAUUSD\n` +
      `Entry: ${signal.entryPrice.toFixed(2)} | SL: ${signal.stopLoss.toFixed(2)} | TP: ${signal.takeProfit.toFixed(2)} | RR 1:${signal.riskReward}\n` +
      `Konfirmasi: ${confirmLabel}\n\n` +
      `Berikan analisis singkat dan rekomendasi untuk sinyal ini. Jelaskan alasan teknikal berdasarkan data di atas. ` +
      `Sebutkan level Entry, SL, dan TP. Ingatkan bahwa ini sinyal teknikal bukan jaminan profit. Tulis dalam teks biasa tanpa format apapun.`;

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

  // ─── User Chat (with conversation memory) ─────────────────────────────────
  // Desain percakapan:
  // conversationHistory hanya menyimpan pertanyaan PENDEK user dan jawaban AI.
  // Saat membangun pesan untuk API:
  //   [0] user: fresh market context + pertanyaan pertama dari history
  //   [1] assistant: jawaban pertama
  //   [2] user: pertanyaan kedua (pendek)
  //   [3] assistant: jawaban kedua
  //   ... dan seterusnya ...
  //   [N] user: pertanyaan baru (current)
  // Dengan cara ini market context hanya muncul sekali (di depan),
  // payload tidak membengkak, dan AI tetap bisa mengingat konteks percakapan.
  async chat(
    userMessage: string,
    snapshot: MarketStateSnapshot
  ): Promise<string> {
    const marketCtx = buildMarketContext(snapshot);
    const messages: Array<{ role: string; content: string }> = [];

    // Max 3 pasang exchange terakhir (6 turns) agar payload ringan dan API cepat
    const recentHistory = this.conversationHistory.slice(-6);

    if (recentHistory.length === 0) {
      // Pertama: market context + pertanyaan langsung
      messages.push({
        role: "user",
        content: `${marketCtx}\n\nPertanyaan: ${userMessage}`,
      });
    } else {
      // Ada history: letakkan market context di awal pesan user pertama dari history
      messages.push({
        role: "user",
        content: `${marketCtx}\n\nPertanyaan sebelumnya: ${recentHistory[0].content}`,
      });
      // Sisa history mulai dari index 1
      for (let i = 1; i < recentHistory.length; i++) {
        messages.push({ role: recentHistory[i].role, content: recentHistory[i].content });
      }
      // Pertanyaan baru
      messages.push({ role: "user", content: userMessage });
    }

    const response = await callPollinationsAI(messages);

    if (!response) {
      return "Maaf, AI tidak dapat merespons saat ini. Coba lagi sebentar.";
    }

    const clean = stripMarkdown(response);

    // Simpan hanya teks pendek (bukan market context) ke history
    this.addToHistory("user", userMessage);
    this.addToHistory("assistant", clean);

    this.addDisplayMessage({
      role: "user",
      content: userMessage,
      type: "user_chat",
    });

    this.addDisplayMessage({
      role: "assistant",
      content: clean,
      type: "user_chat",
    });

    return clean;
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
