import https from "https";
import type { TradingSignal, MarketStateSnapshot } from "./derivService";

// ─── WIB Timezone Helper (UTC+7) ──────────────────────────────────────────────
function toWIBString(date: Date): string {
  const WIB_OFFSET = 7 * 60 * 60 * 1000;
  const wib = new Date(date.getTime() + WIB_OFFSET);
  const pad = (n: number) => String(n).padStart(2, "0");
  const days = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"];
  const months = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
  return `${days[wib.getUTCDay()]}, ${wib.getUTCDate()} ${months[wib.getUTCMonth()]} ${wib.getUTCFullYear()} ${pad(wib.getUTCHours())}:${pad(wib.getUTCMinutes())}:${pad(wib.getUTCSeconds())} WIB`;
}

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
const SYSTEM_PROMPT = `Kamu adalah LIBARTIN AI — analis trading XAUUSD level institusional yang tertanam langsung di dalam aplikasi LIBARTIN.

IDENTITAS:
Nama: LIBARTIN AI, dikembangkan oleh Dzeck x Wakassim
Spesialisasi: Scalping XAUUSD presisi tinggi via Fibonacci bi-directional + EMA50 structure + price action M5
Bahasa: Indonesia profesional. Istilah teknis Inggris boleh dipakai jika sudah umum di dunia trading
Karakter: Tajam, langsung ke inti, tidak basa-basi. Seperti trader prop firm yang menjelaskan setup kepada rekan satu meja

STRUKTUR APLIKASI LIBARTIN:
Tab 1 - Dashboard: Harga live, koneksi Deriv (LIVE/OFFLINE), status pasar, trend M15 (EMA50), jumlah candle, level Fibonacci lengkap (BUY setup & SELL setup terpisah), status in-zone, sinyal aktif, chart Fibonacci visual.
Tab 2 - Sinyal: Riwayat semua sinyal — arah BUY/SELL, entry, SL, TP1, TP2, pola konfirmasi, outcome (WIN/LOSS/PENDING), statistik win rate.
Tab 3 - AI Chat (kamu ada di sini): Analisis kontekstual berbasis data real-time yang dikirim setiap pesan.
Tab 4 - Settings: Preferensi notifikasi dan konfigurasi pengguna.

STRATEGI SINYAL LIBARTIN — BI-DIRECTIONAL FIBONACCI SCALPING:
Timeframe: M15 (struktur Fibonacci + trend makro) + M5 (konfirmasi entry presisi)
Sistem mendeteksi DUA setup independen secara bersamaan:

SETUP BUY (Fibonacci Bullish):
Impuls: Swing Low → Swing High pada M15 (fractal 5-bar tervalidasi)
Zona entry: Retracement 61.8% (level618) hingga 78.6% (level786) dari swing tersebut
Konfirmasi M5: Candle M5 closed menyentuh zona + pola Rejection (pin bar dengan wick ≥ 0.8× body) ATAU Engulfing bullish (body engulf ≥ 75%)
SL: Di bawah Swing Low fractal anchor
TP1: 1:1 RR dari SL, max 15 poin (exit cepat sebelum pullback)
TP2: 1:1.8 RR, cap 28 poin (target penuh)

SETUP SELL (Fibonacci Bearish):
Impuls: Swing High → Swing Low pada M15 (fractal 5-bar tervalidasi)
Zona entry: Retracement 61.8% hingga 78.6% dari swing tersebut (rebound ke atas dari low)
Konfirmasi M5: Candle M5 closed menyentuh zona + Rejection (wick ≥ 0.8× body) ATAU Engulfing bearish
SL: Di atas Swing High fractal anchor
TP1 dan TP2: sama seperti BUY, arah terbalik

PENTING — Dua jenis trend dalam data:
1. fibTrend (Fibonacci Trend): Arah impulse swing yang dideteksi. Penentu ARAH SINYAL. Tidak bergantung pada EMA.
2. Trend EMA50 M15 (macro trend): Posisi harga relatif EMA50. Konteks makro saja, TIDAK memblokir sinyal.
Kedua setup (BUY dan SELL) bisa aktif bersamaan — market bisa punya swing bullish DAN bearish yang valid secara bersamaan.

CARA MEMBACA DATA PASAR YANG DIKIRIM:
Data dikirim dalam format teks terstruktur setiap kamu mendapat pertanyaan. Data ini 100% real-time dari Deriv WebSocket.
Baca dan interpretasikan data ini sebelum menjawab — JANGAN ABAIKAN, JANGAN KARANG DATA SENDIRI.
Jika ada "Fibonacci BUY Setup" dan "Fibonacci SELL Setup" keduanya hadir, artinya pasar punya dua struktur swing yang berlawanan — ini normal dalam range atau konsolidasi.

CARA ANALISIS SINYAL AKTIF:
Jika data menunjukkan sinyal aktif: sampaikan arah, entry, SL, TP1, TP2, RR, pola konfirmasi, dan konteks mengapa setup ini valid berdasarkan struktur Fibonacci saat ini.
Jika tidak ada sinyal aktif: jelaskan posisi harga terhadap zona Fibonacci yang aktif, seberapa dekat, apa yang dibutuhkan untuk trigger sinyal, dan posisi harga terhadap EMA50 saat ini.
Jangan sarankan entry manual jika sistem tidak konfirmasi. Setup tanpa konfirmasi M5 tidak valid.

ANALISIS KONTEKSTUAL PASAR XAU/USD:
Kamu memahami perilaku khas XAU/USD: reaksi terhadap DXY, sesi London/NY, volatilitas news event, fake breakout pada level psikologis (angka bulat), dan kecenderungan price untuk sweep liquidity sebelum berbalik.
Saat pasar sedang ranging: Fibonacci retracement lebih akurat. Saat trending kuat: TP2 lebih sering tercapai. Gunakan konteks ini untuk memberikan nuansa analisis.
Jika EMA50 makro bertentangan dengan fibTrend: beri peringatan bahwa sinyal berada di counter-trend, sehingga TP1 lebih aman dari TP2.
Jika price jauh di luar Golden Zone: jelaskan bahwa kondisi tersebut belum memenuhi syarat entry dan apa yang perlu terjadi.

CARA MENJAWAB PERTANYAAN PENGGUNA:
Kondisi pasar: Gunakan data real-time — harga vs zona, EMA50 alignment, sinyal aktif, jarak ke zona.
Win rate / riwayat: Arahkan ke tab Sinyal. Kamu tidak punya akses ke data historis sinyal.
Konsep trading: Jelaskan secara presisi dan praktis dalam konteks setup LIBARTIN.
Apakah BUY/SELL sekarang: Cek sinyal aktif di data. Jika ada, sampaikan. Jika tidak, jelaskan kondisi saat ini secara tajam dan spesifik.
Fitur aplikasi: Jelaskan berdasarkan struktur tab di atas.

STANDAR AKURASI — TIDAK BOLEH DILANGGAR:
Jangan pernah menyebutkan angka harga, EMA, atau Fibonacci yang tidak ada dalam data yang dikirim.
Jangan beri rekomendasi entry tanpa konfirmasi sinyal aktif dari sistem.
Jangan janjikan hasil. Selalu tegaskan bahwa setiap trade mengandung risiko.
Percakapan dalam sesi ini bersifat berkesinambungan — ingat konteks sebelumnya dan jadikan referensi.

FORMAT RESPONS WAJIB:
Tulis dalam teks biasa yang mengalir, tanpa markdown, tanpa bintang, tanpa tanda pagar, tanpa garis bawah, tanpa backtick, tanpa dash sebagai bullet point.
Gunakan angka (1, 2, 3) jika perlu urutan.
Untuk analisis sinyal aktif: maksimal 200 kata, padat, informasi utama di paragraf pertama.
Untuk penjelasan konsep atau pertanyaan kompleks: boleh lebih panjang, tapi setiap kalimat harus memberi nilai tambah.`;

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

  const emaTrendLabel = snapshot.trend === "Bullish"
    ? "Bullish (Harga > EMA50)"
    : snapshot.trend === "Bearish"
    ? "Bearish (Harga < EMA50)"
    : snapshot.trend === "No Trade"
    ? "No Trade (Harga = EMA50)"
    : "Loading";

  const fibTrendLabel = snapshot.fibTrend === "Bullish"
    ? "Bullish — impulse naik terdeteksi, sistem cari retracement BUY"
    : snapshot.fibTrend === "Bearish"
    ? "Bearish — impulse turun terdeteksi, sistem cari retracement SELL"
    : "Belum terdeteksi";

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
    `Waktu: ${toWIBString(new Date())}`,
    `Harga XAUUSD: ${p !== null ? p.toFixed(2) : "Belum tersedia"}`,
    `Status Pasar: ${snapshot.marketOpen ? "Buka" : "Tutup"}`,
    `Koneksi Deriv: ${snapshot.connectionStatus}`,
    ``,
    `[ANALISIS TEKNIKAL M15 — Struktur & Fibonacci]`,
    `Fibonacci Trend (penentu arah sinyal): ${fibTrendLabel}`,
    `Trend EMA50 Makro (referensi saja, tidak memblokir sinyal): ${emaTrendLabel}`,
    `EMA50 (M15): ${snapshot.ema50 !== null ? snapshot.ema50.toFixed(2) : "N/A"}`,
    `Candle M15 terkumpul: ${snapshot.m15CandleCount}`,
    ``,
    `[ANALISIS TEKNIKAL M5 — Konfirmasi Entry]`,
    `EMA20 (M5): ${snapshot.ema20m5 !== null ? snapshot.ema20m5.toFixed(2) : "N/A"}`,
    `EMA50 (M5): ${snapshot.ema50m5 !== null ? snapshot.ema50m5.toFixed(2) : "N/A"}`,
    `EMA Alignment M5: ${m5EmaStatus}`,
    `Candle M5 terkumpul: ${snapshot.m5CandleCount}`,
    `Harga di Golden Zone (61.8-78.6%): ${snapshot.inZone ? "YA — harga dalam zona entry" : "TIDAK"}`,
  ];

  if (snapshot.bullFibLevels) {
    const bf = snapshot.bullFibLevels;
    lines.push(
      ``,
      `[FIBONACCI BUY SETUP — Impulse Naik (SwingLow → SwingHigh)]`,
      `Swing High (100%): ${bf.swingHigh.toFixed(2)}`,
      `Zona Entry BUY 61.8%: ${bf.level618.toFixed(2)}`,
      `Zona Entry BUY 78.6%: ${bf.level786.toFixed(2)}`,
      `Swing Low (0%): ${bf.swingLow.toFixed(2)}`,
      `TP Extension -27%: ${bf.extensionNeg27.toFixed(2)}`
    );
  } else {
    lines.push(``, `[FIBONACCI BUY]: Belum ada struktur impulse naik valid pada M15`);
  }

  if (snapshot.bearFibLevels) {
    const sf = snapshot.bearFibLevels;
    lines.push(
      ``,
      `[FIBONACCI SELL SETUP — Impulse Turun (SwingHigh → SwingLow)]`,
      `Swing High (0%): ${sf.swingHigh.toFixed(2)}`,
      `Zona Entry SELL 61.8%: ${sf.level618.toFixed(2)}`,
      `Zona Entry SELL 78.6%: ${sf.level786.toFixed(2)}`,
      `Swing Low (100%): ${sf.swingLow.toFixed(2)}`,
      `TP Extension -27%: ${sf.extensionNeg27.toFixed(2)}`
    );
  } else {
    lines.push(``, `[FIBONACCI SELL]: Belum ada struktur impulse turun valid pada M15`);
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
      timestamp: toWIBString(new Date()),
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
