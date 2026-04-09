import { CohereClientV2 } from "cohere-ai";
import type { TradingSignal, MarketStateSnapshot } from "./derivService";
import { toWIBString } from "../shared/utils";

const cohereClient = new CohereClientV2({
  token: process.env.COHERE_API_KEY ?? "",
});

// ─── Rate Limiter (Masalah 3b) ─────────────────────────────────────────────────
// Maks 5 pesan per menit per session (in-memory, keyed by IP/sessionId)
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

export function checkRateLimit(key: string, maxPerMin = 5): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(key);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (entry.count >= maxPerMin) return false;
  entry.count++;
  return true;
}

// Bersihkan map setiap 5 menit untuk hindari memory leak
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateLimitMap.entries()) {
    if (now > v.resetAt) rateLimitMap.delete(k);
  }
}, 5 * 60_000);

export interface AIMessage {
  id: string;
  role: "assistant" | "user";
  content: string;
  thinking?: string;
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

// ─── Parse Thinking Tags ──────────────────────────────────────────────────────
// Pisahkan konten <thinking>...</thinking> dari respons utama AI.
// Model diminta menulis proses berpikir dalam tag ini sebelum menjawab.
function parseThinking(raw: string): { thinking: string | null; response: string } {
  const match = raw.match(/^<thinking>([\s\S]*?)<\/thinking>\s*/);
  if (match) {
    const thinking = match[1].trim();
    const response = raw.slice(match[0].length).trim();
    return { thinking: thinking || null, response };
  }
  return { thinking: null, response: raw };
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
Spesialisasi: Scalping XAUUSD presisi tinggi via Fibonacci bi-directional + EMA multi-timeframe + price action M5
Bahasa: Indonesia profesional. Istilah teknis Inggris boleh dipakai jika sudah umum di dunia trading
Karakter: Tajam, langsung ke inti, tidak basa-basi. Seperti trader prop firm yang menjelaskan setup kepada rekan satu meja

STRUKTUR APLIKASI LIBARTIN:
Tab 1 - Dashboard: Harga live XAUUSD dari Deriv WebSocket, status koneksi (LIVE/OFFLINE), trend M15 (EMA50 makro), jumlah candle M15/M5, level Fibonacci lengkap (BUY dan SELL terpisah), status in-zone, sinyal aktif, chart Fibonacci visual interaktif, level EMA20/EMA50 M5.
Tab 2 - Sinyal: Riwayat semua sinyal — arah BUY/SELL, entry, SL, TP1, TP2, RR, pola konfirmasi, outcome (WIN/LOSS/EXPIRED/PENDING), statistik win rate keseluruhan.
Tab 3 - AI Chat (kamu ada di sini): Analisis kontekstual real-time berbasis data pasar yang dikirim bersamaan setiap kamu mendapat pesan.
Tab 4 - Settings: Preferensi notifikasi push dan konfigurasi pengguna.

STRATEGI SINYAL LIBARTIN — BI-DIRECTIONAL FIBONACCI SCALPING:
Timeframe utama: M15 untuk deteksi struktur impulse + Fibonacci + trend makro. M5 untuk konfirmasi entry presisi.
Sistem mendeteksi DUA setup secara independen dan bersamaan (BUY dan SELL bisa aktif sekaligus).

SETUP BUY (Fibonacci Bullish):
Impulse: Swing Low → Swing High pada M15 yang valid (fractal 5-bar, span 3-40 candle, range min 0.3× ATR14, bersih — tidak ada retracement >30% selama impulse, bagian kedua impulse rata-rata lebih tinggi dari bagian pertama).
Konfirmasi trend: Harga di atas EMA50 M15 (konteks makro) dan EMA20 M5 di atas EMA50 M5 (alignment entry).
Zona entry (Golden Zone): Retracement 61.8% hingga 78.6% dari swing tersebut. Filter masuk zona juga cek 50%-88.6% untuk pola wick.
Konfirmasi M5 (WAJIB): Candle M5 CLOSED yang wicknya menyentuh zona 50%-88.6% + salah satu pola berikut:
  - Pin Bar Rejection bullish: wick bawah ≥ 0.8× body candle, candle bukan doji (body ≥ 30% range total)
  - Engulfing bullish: body candle current menutup ≥ 75% dari body candle sebelumnya, candle bukan doji, dan harus ada salah satu: level round number (.25/.50) dalam 2 poin ATAU swing point M5 dalam 5 candle terakhir
Entry: Harga close candle M5 yang memenuhi konfirmasi.
SL: Di bawah Swing Low anchor fractal. Jarak minimum SL = max(0.3× ATR14 M15, 2.0 poin).
TP1: Entry + jarak SL×1 (RR 1:1), dikap 15 poin.
TP2: Level Fibonacci extension -27.2% dari swing + 0.5× ATR14 M15, dikap 3× jarak SL dari entry (maks ~28 poin).
Breakeven: Setelah TP1 tercapai, SL otomatis pindah ke harga entry. Jika kemudian harga kena SL breakeven → outcome WIN.

SETUP SELL (Fibonacci Bearish):
Impulse: Swing High → Swing Low pada M15 (simetris dengan BUY, arah terbalik).
Konfirmasi trend: Harga di bawah EMA50 M15, EMA20 M5 di bawah EMA50 M5.
Zona entry: Retracement 61.8%-78.6% dari swing turun (harga rebound ke atas dari swing low).
Konfirmasi M5: Candle M5 closed + Pin Bar Rejection bearish (wick atas ≥ 0.8× body) ATAU Engulfing bearish (body ≥ 75% candle sebelumnya + round number/swing confluence).
SL: Di atas Swing High anchor. TP1 dan TP2: sama seperti BUY, arah terbalik.

SISTEM PERLINDUNGAN DAN FILTER:
1. Session filter: Sinyal hanya aktif saat London (07:00-16:00 UTC) atau New York (13:00-22:00 UTC). Di luar sesi ini sinyal ditandai "low_confidence".
2. Spike zone: Entry TIDAK diambil dalam 30 menit pertama London Open (07:00-07:30 UTC) dan NY Open (13:00-13:30 UTC) — zona stop hunt / spike tinggi.
3. Max 1 sinyal per arah per anchor Fibonacci — tidak ada sinyal duplikat.
4. Tidak ada cooldown atau batas sinyal — sistem mencari setup valid terus-menerus tanpa jeda paksa, 24 jam sehari. EXPIRED hanya berarti setup tidak terkonfirmasi dalam 5 jam, bukan loss.
5. Expiry: Sinyal yang belum resolved dalam 5 jam otomatis ditandai EXPIRED.
6. Lot size: Otomatis dihitung berdasarkan risiko 1% dari saldo $10.000.

INDIKATOR TEKNIKAL YANG DIGUNAKAN:
EMA50 M15: Referensi makro trend. Harga di atas = Bullish, di bawah = Bearish.
EMA20 M5 dan EMA50 M5: Alignment konfirmasi entry. Harus selaras dengan arah sinyal.
ATR14 M15: Digunakan untuk ukuran swing minimum, jarak SL minimum, dan batas TP2 maksimum.
Fibonacci: 0%, 50%, 61.8%, 78.6%, 88.6%, 100%, -27.2% (extension TP2).

DUA JENIS TREND DALAM DATA — BEDAKAN DENGAN BENAR:
1. fibTrend (Fibonacci Trend): Arah impulse swing yang berhasil dideteksi sistem. INI penentu ARAH SINYAL. Bisa Bullish dan Bearish sekaligus jika dua swing independen terdeteksi.
2. Trend EMA50 M15 (macro trend): Posisi harga relatif EMA50 M15. Ini KONTEKS MAKRO, bukan blocker sinyal. Jika fibTrend berlawanan dengan EMA50 trend, beri catatan bahwa sinyal counter-trend dan prioritaskan TP1.

CARA MEMBACA DATA PASAR YANG DIKIRIM:
Setiap pesan pengguna disertai snapshot pasar real-time dari Deriv WebSocket. Baca dan interpretasikan data ini SEBELUM menjawab.
JANGAN ABAIKAN DATA. JANGAN KARANG ANGKA SENDIRI.
Jika Fibonacci BUY dan SELL sama-sama hadir: pasar sedang ranging/konsolidasi dengan dua swing berlawanan yang valid. Normal.
Jika hanya satu arah: market sedang satu sisi (trending kuat).

CARA ANALISIS SINYAL AKTIF:
Sinyal aktif ada: sampaikan arah, entry, SL, TP1, TP2, RR, pola konfirmasi, status breakeven jika aktif, sesi saat sinyal dibuka, dan beri konteks kenapa setup ini valid.
Tidak ada sinyal aktif: jelaskan posisi harga vs Golden Zone (jarak ke 61.8% dan 78.6%), apa yang dibutuhkan untuk trigger, dan kondisi EMA alignment M5 saat ini.
Jangan sarankan entry manual tanpa konfirmasi sistem. Setup tanpa konfirmasi candle M5 closed tidak valid.

ANALISIS KONTEKSTUAL PASAR XAUUSD:
XAU/USD bereaksi kuat terhadap: DXY, data inflasi AS (CPI/PCE), keputusan suku bunga Fed, geopolitik, dan sesi London/NY overlap.
Angka bulat (.00, .25, .50, .75) bertindak sebagai level support/resistance psikologis — sistem mempertimbangkannya saat konfirmasi Engulfing.
Saat pasar ranging: Fibonacci retracement lebih akurat, target TP1 lebih aman. Saat trending kuat: TP2 lebih realistis.
Jika EMA50 makro berlawanan dengan fibTrend: sinyal counter-trend, risiko lebih tinggi, sarankan fokus ke TP1.
Jika dalam spike zone atau luar sesi: jelaskan mengapa sinyal saat itu "low_confidence" atau tidak ada.

CARA MENJAWAB PERTANYAAN PENGGUNA:
Kondisi pasar saat ini: Gunakan data real-time — harga vs zona, EMA alignment semua timeframe, sinyal aktif, jarak ke Golden Zone.
Win rate / performa: Gunakan data statistik yang ada di snapshot. Kamu PUNYA akses ke data ini — wins, losses, pending, win rate. Jawab langsung dengan angka real.
Konsep trading: Jelaskan secara presisi dalam konteks strategi LIBARTIN yang spesifik.
BUY/SELL sekarang?: Cek sinyal aktif. Jika ada, sampaikan lengkap. Jika tidak, jelaskan kondisi aktual tajam dan spesifik.
Fitur aplikasi: Jelaskan berdasarkan struktur tab, terutama apa yang terlihat di Dashboard dan tab Sinyal.
Tentang proyek LIBARTIN: Kamu tahu semua — ini aplikasi trading XAUUSD real-time berbasis Fibonacci scalping, dikembangkan oleh Dzeck x Wakassim, terhubung live ke broker Deriv via WebSocket.

STANDAR AKURASI — TIDAK BOLEH DILANGGAR:
Jangan sebut angka harga, EMA, Fibonacci, atau ATR yang tidak ada dalam data yang dikirim.
Jangan beri rekomendasi entry tanpa sinyal aktif dari sistem.
Jangan janjikan hasil. Setiap trade mengandung risiko, tegas soal ini jika ditanya.
Percakapan berkesinambungan dalam sesi ini — ingat dan referensikan konteks sebelumnya jika relevan.

FORMAT RESPONS WAJIB:
Tulis dalam teks biasa yang mengalir — tanpa markdown, tanpa bintang, tanpa tanda pagar, tanpa garis bawah, tanpa backtick, tanpa dash bullet point.
Gunakan angka (1, 2, 3) jika perlu urutan atau daftar.
Analisis sinyal aktif: maksimal 200 kata, padat, informasi utama di paragraf pertama.
Penjelasan konsep atau pertanyaan kompleks: boleh lebih panjang, tapi setiap kalimat harus memberi nilai tambah — tidak ada kalimat pengisi.`;

// ─── Call Cohere AI (with retry) ──────────────────────────────────────────────
async function callCohereAI(
  messages: Array<{ role: string; content: string }>,
  attempt = 0
): Promise<string> {
  const cohereMessages = messages.map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));

  try {
    // Masalah 3d: timeout 20 detik (dari 35 detik)
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Cohere timeout (20s)")), 20000)
    );
    const responsePromise = cohereClient.chat({
      model: "command-a-03-2025",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...cohereMessages,
      ],
    });

    const response = await Promise.race([responsePromise, timeoutPromise]);

    const content =
      response.message?.content?.[0]?.type === "text"
        ? response.message.content[0].text
        : "";

    if (!content && attempt === 0) {
      console.warn("[AIService] Empty content from Cohere, retrying...");
      await new Promise((r) => setTimeout(r, 2000));
      return callCohereAI(messages, 1);
    }

    return stripMarkdown(content.trim());
  } catch (err) {
    const errMsg = (err as Error).message ?? "unknown error";
    console.error(`[AIService] Cohere error (attempt ${attempt}): ${errMsg}`);
    if (attempt === 0) {
      await new Promise((r) => setTimeout(r, 3000));
      return callCohereAI(messages, 1);
    }
    return "";
  }
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

  const nowUtcHour = new Date().getUTCHours();
  const nowUtcMin  = new Date().getUTCMinutes();
  const minsInDay  = nowUtcHour * 60 + nowUtcMin;
  const inLondon   = nowUtcHour >= 7 && nowUtcHour < 16;
  const inNY       = nowUtcHour >= 13 && nowUtcHour < 22;
  const inLondonSpike = minsInDay >= 420 && minsInDay < 450;
  const inNYSpike     = minsInDay >= 780 && minsInDay < 810;
  const sessionLabel = (() => {
    if (inLondonSpike) return "SPIKE ZONE London Open (07:00-07:30 UTC) — tidak ada sinyal baru";
    if (inNYSpike)     return "SPIKE ZONE NY Open (13:00-13:30 UTC) — tidak ada sinyal baru";
    if (inLondon && inNY) return "London + New York (overlap — volatilitas tinggi)";
    if (inLondon)      return "London Session (07:00-16:00 UTC)";
    if (inNY)          return "New York Session (13:00-22:00 UTC)";
    return "Di luar sesi aktif (Asia/weekend) — sinyal low_confidence";
  })();

  const lines: string[] = [
    `[DATA PASAR REAL-TIME — LIBARTIN]`,
    `Waktu: ${toWIBString(new Date())}`,
    `Harga XAUUSD: ${p !== null ? p.toFixed(2) : "Belum tersedia"}`,
    `Status Pasar: ${snapshot.marketOpen ? "Buka" : "Tutup"}`,
    `Sesi Trading: ${sessionLabel}`,
    `Koneksi Deriv: ${snapshot.connectionStatus}`,
    ``,
    `[ANALISIS TEKNIKAL M15 — Struktur & Fibonacci]`,
    `Fibonacci Trend (penentu arah sinyal): ${fibTrendLabel}`,
    `Trend EMA50 Makro (referensi, tidak memblokir sinyal): ${emaTrendLabel}`,
    `EMA50 (M15): ${snapshot.ema50 !== null ? snapshot.ema50.toFixed(2) : "N/A"}`,
    `ATR14 (M15): ${snapshot.atrM15 !== null ? snapshot.atrM15.toFixed(2) + " poin" : "N/A"}`,
    `Candle M15 terkumpul: ${snapshot.m15CandleCount}`,
    ``,
    `[ANALISIS TEKNIKAL M5 — Konfirmasi Entry]`,
    `EMA20 (M5): ${snapshot.ema20m5 !== null ? snapshot.ema20m5.toFixed(2) : "N/A"}`,
    `EMA50 (M5): ${snapshot.ema50m5 !== null ? snapshot.ema50m5.toFixed(2) : "N/A"}`,
    `EMA Alignment M5: ${m5EmaStatus}`,
    `Candle M5 terkumpul: ${snapshot.m5CandleCount}`,
    `Harga di Golden Zone (61.8-78.6%): ${snapshot.inZone ? "YA — harga dalam zona entry" : "TIDAK"}`,
    ``,
    `[SISTEM PERLINDUNGAN]`,
    `Sinyal: UNLIMITED — tidak ada cooldown, sistem mencari setup 24/7`,
  ];

  const stats = snapshot.signalStats;
  if (stats) {
    const winRateLabel = stats.total === 0
      ? "Belum ada sinyal"
      : `${stats.winRate}% (${stats.wins} WIN / ${stats.losses} LOSS dari ${stats.wins + stats.losses} sinyal closed)`;
    lines.push(
      ``,
      `[STATISTIK SINYAL LIBARTIN]`,
      `Total sinyal tercatat: ${stats.total}`,
      `WIN: ${stats.wins}`,
      `LOSS: ${stats.losses}`,
      `Pending (belum closed): ${stats.pending}`,
      `Win Rate: ${winRateLabel}`
    );
  }

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

  // Masalah 3c: Tambahkan riwayat 5 sinyal terakhir agar AI bisa analisis pola
  const recentClosed = snapshot.recentSignals?.filter(
    (s) => s.outcome === "win" || s.outcome === "loss" || s.outcome === "expired"
  ).slice(0, 5);
  if (recentClosed && recentClosed.length > 0) {
    lines.push(``, `[RIWAYAT 5 SINYAL TERAKHIR]`);
    recentClosed.forEach((s, i) => {
      const dir = s.trend === "Bullish" ? "BUY" : "SELL";
      const outcomeLabel = s.outcome === "win" ? "WIN" : s.outcome === "loss" ? "LOSS" : "EXPIRED";
      const wib = toWIBString(new Date(s.timestampUTC));
      lines.push(
        `${i + 1}. ${dir} @ ${s.entryPrice.toFixed(2)} | SL ${s.stopLoss.toFixed(2)} | TP1 ${s.takeProfit.toFixed(2)}` +
        ` | RR 1:${s.riskReward} | ${outcomeLabel} | ${s.confirmationType} | ${wib}`
      );
    });
  }

  return lines.join("\n");
}

// ─── AI Service ────────────────────────────────────────────────────────────────
class AIService {
  private displayMessages: AIMessage[] = [];
  private conversationHistory: ConversationTurn[] = [];
  private isGenerating = false;
  private isGeneratingZoneAlert = false;
  private isGeneratingOutcome = false;
  private lastSignalId: string | null = null;
  private lastZoneKeys: { bull: string | null; bear: string | null } = { bull: null, bear: null };

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

    try {
      const response = await callCohereAI([{ role: "user", content: userMsg }]);

      const clean = response
        ? stripMarkdown(response)
        : `Sinyal ${direction} XAUUSD terdeteksi — Entry: ${signal.entryPrice.toFixed(2)}, SL: ${signal.stopLoss.toFixed(2)}, TP1: ${signal.takeProfit.toFixed(2)}${signal.takeProfit2 ? `, TP2: ${signal.takeProfit2.toFixed(2)}` : ""}. AI Advisor tidak dapat memberikan analisis mendalam saat ini. Pantau level-level tersebut dan kelola risiko dengan disiplin.`;

      if (!response) {
        console.warn("[AIService] Empty response for signal recommendation — using fallback");
      }

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
    } catch (e) {
      console.error("[AIService] Error generating signal recommendation:", (e as Error).message);
    } finally {
      this.isGenerating = false;
    }
  }

  // ─── Zone Entry Alert (auto-triggered when price enters Fibonacci zone) ─────
  // Pesan singkat: "Harga sudah masuk zona BUY/SELL — pantau konfirmasi M5"
  // Berjalan di flag isGeneratingZoneAlert tersendiri agar tidak blokir sinyal.
  async generateZoneAlert(
    snapshot: MarketStateSnapshot,
    direction: "Bullish" | "Bearish",
    zoneKey: string
  ): Promise<void> {
    const dir = direction === "Bullish" ? "bull" : "bear";
    if (this.lastZoneKeys[dir] === zoneKey) return;
    if (this.isGeneratingZoneAlert) return;
    this.isGeneratingZoneAlert = true;
    this.lastZoneKeys[dir] = zoneKey;

    const dirLabel = direction === "Bullish" ? "BUY" : "SELL";
    const marketCtx = buildMarketContext(snapshot);

    const fib = direction === "Bullish" ? snapshot.bullFibLevels : snapshot.bearFibLevels;
    const zoneInfo = fib
      ? ` antara ${fib.level786.toFixed(2)}–${fib.level618.toFixed(2)}`
      : "";

    const userMsg =
      `${marketCtx}\n\n` +
      `ALERT ZONA ${dirLabel}: Harga XAUUSD (${snapshot.currentPrice?.toFixed(2) ?? "?"}) baru saja masuk ke Golden Zone Fibonacci ${dirLabel}${zoneInfo}.\n` +
      `Sistem sekarang memantau konfirmasi candlestick M5 (Pin Bar Rejection atau Engulfing) untuk validasi entry.\n\n` +
      `Tulis pesan singkat kepada trader — seperti analis prop firm yang memberi tahu secara langsung:\n` +
      `1) Bahwa harga sudah masuk zona ${dirLabel} Fibonacci (sebutkan area harga spesifik dari data)\n` +
      `2) Apa yang akan dipantau untuk konfirmasi M5 (sebutkan kondisi EMA alignment saat ini)\n` +
      `3) Instruksi singkat: siap-siap setup, belum entry sebelum konfirmasi closed M5 valid\n` +
      `Tulis dalam 3–4 kalimat saja, gaya bicara langsung dan tajam, teks biasa tanpa format.`;

    console.log(`[AIService] Generating zone alert: ${dirLabel} zone @ ${snapshot.currentPrice?.toFixed(2)}`);

    try {
      const response = await callCohereAI([{ role: "user", content: userMsg }]);

      const fallback =
        `Harga XAUUSD (${snapshot.currentPrice?.toFixed(2) ?? "?"}) masuk zona ${dirLabel} Fibonacci${zoneInfo}. ` +
        `Sistem sekarang memantau konfirmasi candle M5 — tunggu Pin Bar atau Engulfing closed sebelum entry. ` +
        `Belum ada sinyal valid, jangan jump in dulu.`;

      const clean = response ? stripMarkdown(response) : fallback;

      this.addDisplayMessage({
        role: "assistant",
        content: clean,
        type: "market",
        metadata: { trend: direction },
      });

      this.addToHistory("assistant", clean);

      console.log(`[AIService] Zone alert done (${clean.length} chars)`);
    } catch (e) {
      console.error("[AIService] Zone alert error:", (e as Error).message);
    } finally {
      this.isGeneratingZoneAlert = false;
    }
  }

  // Reset zone key for a direction (called when price exits zone or Fibonacci anchor changes)
  resetZoneKey(direction: "Bullish" | "Bearish"): void {
    const dir = direction === "Bullish" ? "bull" : "bear";
    this.lastZoneKeys[dir] = null;
  }

  // ─── TP1 Hit Alert (instant notification, no AI call needed) ───────────────
  // Segera kirim notifikasi saat TP1 tercapai — SL geser ke breakeven.
  // Gunakan flagnya sendiri agar tidak terblokir oleh AI generation lain.
  notifyTP1Hit(signal: TradingSignal): void {
    const direction = signal.trend === "Bullish" ? "BUY" : "SELL";
    const tp2Info = signal.takeProfit2
      ? ` TP2 masih aktif di ${signal.takeProfit2.toFixed(2)} (RR 1:${signal.riskReward2 ?? "?"}).`
      : " Tidak ada TP2 — trade selesai.";

    const instant =
      `TP1 ${direction} tercapai di ${signal.takeProfit.toFixed(2)}! ` +
      `SL sudah otomatis digeser ke breakeven (entry ${signal.entryPrice.toFixed(2)}) — posisi sekarang risk-free.` +
      tp2Info +
      ` Pantau pergerakan, jangan buru-buru tutup jika TP2 masih dalam jangkauan.`;

    this.addDisplayMessage({
      role: "assistant",
      content: instant,
      type: "outcome",
      metadata: {
        signalId: signal.id,
        trend: signal.trend,
        outcome: "win",
        entryPrice: signal.entryPrice,
      },
    });

    console.log(`[AIService] TP1 alert sent: ${direction} @ ${signal.takeProfit.toFixed(2)}`);

    // Trigger AI elaboration in background (non-blocking, separate from isGenerating)
    const snapshot = { currentPrice: null, trend: "Loading" } as unknown as MarketStateSnapshot;
    this.generateTP1Elaboration(signal, snapshot).catch((e) =>
      console.error("[AIService] TP1 elaboration error:", e)
    );
  }

  private async generateTP1Elaboration(signal: TradingSignal, _snapshot: MarketStateSnapshot): Promise<void> {
    if (this.isGenerating) return;
    this.isGenerating = true;
    const direction = signal.trend === "Bullish" ? "BUY" : "SELL";
    const tp2Info = signal.takeProfit2
      ? ` TP2 target: ${signal.takeProfit2.toFixed(2)} (RR 1:${signal.riskReward2 ?? "?"}).`
      : "";
    const userMsg =
      `TP1 sinyal ${direction} XAUUSD baru saja tercapai di ${signal.takeProfit.toFixed(2)}. ` +
      `Entry: ${signal.entryPrice.toFixed(2)}, SL asli: ${signal.stopLoss.toFixed(2)}.${tp2Info} ` +
      `SL sudah otomatis geser ke breakeven. ` +
      `Tulis 1-2 kalimat singkat saja: apresiasi, ingatkan pantau TP2 jika ada, tetap disiplin. Teks biasa tanpa format.`;
    try {
      const response = await callCohereAI([{ role: "user", content: userMsg }]);
      if (!response) return;
      const clean = stripMarkdown(response);
      this.addToHistory("assistant", clean);
    } catch (e) {
      console.error("[AIService] TP1 elaboration failed:", (e as Error).message);
    } finally {
      this.isGenerating = false;
    }
  }

  // ─── Outcome Commentary (auto-triggered on TP2/SL) ─────────────────────────
  // Gunakan flag isGeneratingOutcome agar tidak terblokir oleh AI call lain
  // (zone alert, signal recommendation, dll).
  async generateOutcomeCommentary(
    signal: TradingSignal,
    outcome: "win" | "loss",
    snapshot: MarketStateSnapshot
  ): Promise<void> {
    // Outcome commentary adalah prioritas tinggi — tidak peduli isGenerating lain
    // tapi tetap tunggu jika ada outcome lain yang sedang diproses.
    if (this.isGeneratingOutcome) return;
    this.isGeneratingOutcome = true;

    const direction = signal.trend === "Bullish" ? "BUY" : "SELL";
    const outcomeLabel = outcome === "win" ? "TP TERCAPAI WIN" : "SL TERCAPAI LOSS";
    const marketCtx = buildMarketContext(snapshot);

    const userMsg =
      `${marketCtx}\n\n` +
      `HASIL TRADE: ${outcomeLabel}\n` +
      `Arah: ${direction} XAUUSD\n` +
      `Entry: ${signal.entryPrice.toFixed(2)} | SL: ${signal.stopLoss.toFixed(2)} | TP: ${signal.takeProfit.toFixed(2)}` +
      (signal.takeProfit2 ? ` | TP2: ${signal.takeProfit2.toFixed(2)}` : "") + `\n\n` +
      (outcome === "win"
        ? `TP berhasil dicapai. Berikan komentar singkat — sebutkan level yang berhasil, dorong disiplin, ingatkan risiko trade berikutnya. Tulis teks biasa tanpa format, maksimal 3 kalimat.`
        : `SL tercapai. Berikan komentar singkat — ingatkan bahwa loss normal, disiplin SL melindungi akun, setup berikutnya harus tetap ikut sistem. Teks biasa, maksimal 3 kalimat.`);

    console.log(`[AIService] Generating outcome commentary: ${outcomeLabel}`);

    try {
      const response = await callCohereAI(
        this.buildMessagesWithHistory(userMsg)
      );

      const fallback = outcome === "win"
        ? `Trade ${direction} selesai dengan WIN. TP tercapai dengan baik — sistem bekerja sesuai rencana. Tetap disiplin untuk setup berikutnya.`
        : `Trade ${direction} kena SL — ini bagian normal dari trading. Disiplin SL melindungi akun dari kerugian besar. Reset dan tunggu setup berikutnya yang valid.`;

      const clean = response ? stripMarkdown(response) : fallback;

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
    } catch (e) {
      console.error("[AIService] Outcome commentary error:", (e as Error).message);
    } finally {
      this.isGeneratingOutcome = false;
    }
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

    // Instruksi thinking — model diminta menulis proses analisis dalam <thinking> tags
    // sebelum jawaban utama. Ini akan ditampilkan sebagai "Proses Berpikir" di UI.
    const thinkingPrefix =
      `[MODE BERPIKIR AKTIF]\n` +
      `Sebelum menjawab, tulis proses analisamu dalam tag <thinking>...</thinking>. ` +
      `Isi tag: bagaimana kamu membaca pertanyaan ini, data pasar mana yang paling relevan, ` +
      `dan apa inti jawaban yang paling tepat untuk trader. Tulis 2-4 kalimat di dalam tag — ` +
      `tajam dan fokus. Setelah tag, tulis jawaban utama dalam teks biasa tanpa tag.\n\n`;

    const firstUserContent = `${marketCtx}\n\nPertanyaan: ${userMessage}`;

    if (recentHistory.length === 0) {
      messages.push({
        role: "user",
        content: thinkingPrefix + firstUserContent,
      });
    } else {
      messages.push({
        role: "user",
        content: thinkingPrefix + `${marketCtx}\n\nPertanyaan sebelumnya: ${recentHistory[0].content}`,
      });
      for (let i = 1; i < recentHistory.length; i++) {
        messages.push({ role: recentHistory[i].role, content: recentHistory[i].content });
      }
      messages.push({ role: "user", content: userMessage });
    }

    const rawResponse = await callCohereAI(messages);
    const { thinking, response: parsed } = parseThinking(rawResponse ?? "");

    const clean = parsed
      ? stripMarkdown(parsed)
      : "Maaf, AI tidak dapat merespons saat ini. Silakan coba lagi sebentar.";

    const cleanThinking = thinking ? stripMarkdown(thinking) : undefined;

    this.addToHistory("user", userMessage);
    this.addToHistory("assistant", clean);

    this.addDisplayMessage({ role: "user", content: userMessage, type: "user_chat" });
    this.addDisplayMessage({
      role: "assistant",
      content: clean,
      type: "user_chat",
      thinking: cleanThinking,
      ...(requestId ? { metadata: { requestId } } : {}),
    });

    return clean;
  }

  // ─── User Chat Streaming ───────────────────────────────────────────────────
  chatStream(
    userMessage: string,
    snapshot: MarketStateSnapshot,
    onChunk: (chunk: string) => void,
    onDone: (fullResponse: string, thinking?: string) => void,
    onError: (err: string) => void
  ): void {
    const marketCtx = buildMarketContext(snapshot);
    const messages: Array<{ role: string; content: string }> = [];
    const recentHistory = this.conversationHistory.slice(-6);

    const thinkingPrefix =
      `[MODE BERPIKIR AKTIF]\n` +
      `Sebelum menjawab, tulis proses analisamu dalam tag <thinking>...</thinking>. ` +
      `Isi tag: bagaimana kamu membaca pertanyaan ini, data pasar mana yang paling relevan, ` +
      `dan apa inti jawaban yang paling tepat untuk trader. Tulis 2-4 kalimat di dalam tag — ` +
      `tajam dan fokus. Setelah tag, tulis jawaban utama dalam teks biasa tanpa tag.\n\n`;

    if (recentHistory.length === 0) {
      messages.push({
        role: "user",
        content: thinkingPrefix + `${marketCtx}\n\nPertanyaan: ${userMessage}`,
      });
    } else {
      messages.push({
        role: "user",
        content: thinkingPrefix + `${marketCtx}\n\nPertanyaan sebelumnya: ${recentHistory[0].content}`,
      });
      for (let i = 1; i < recentHistory.length; i++) {
        messages.push({ role: recentHistory[i].role, content: recentHistory[i].content });
      }
      messages.push({ role: "user", content: userMessage });
    }

    callCohereAI(messages).then((fullResponse) => {
      const { thinking, response: parsed } = parseThinking(fullResponse ?? "");
      const clean = parsed.trim() || "Maaf, AI tidak dapat merespons saat ini.";
      const cleanThinking = thinking ? stripMarkdown(thinking) : undefined;

      this.addToHistory("user", userMessage);
      this.addToHistory("assistant", clean);
      this.addDisplayMessage({ role: "user", content: userMessage, type: "user_chat" });
      this.addDisplayMessage({ role: "assistant", content: clean, type: "user_chat", thinking: cleanThinking });

      streamWordByWord(clean, onChunk, () => onDone(clean, cleanThinking));
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
