import type { Express, Request, Response } from "express";
import { createServer, type Server } from "node:http";
import { derivService } from "./derivService";
import { aiService, checkRateLimit } from "./aiService";

export async function registerRoutes(app: Express): Promise<Server> {
  app.get("/api/market-state", (_req: Request, res: Response) => {
    res.json(derivService.getSnapshot());
  });

  app.get("/api/signals", (_req: Request, res: Response) => {
    res.json(derivService.getSignalHistory());
  });

  // GET /api/current-signal — returns the active signal (pending or just resolved).
  // Used by frontend polling to track active trade state and receive TP/SL outcomes.
  // Fallback: jika currentSignal null (mis. setelah restart sebelum candle baru),
  // kembalikan sinyal pending terbaru dari history — hanya jika searah dengan
  // trend M15 aktif dan belum dibatalkan karena trend reversal.
  // Ini mencegah sinyal yang sudah dibatalkan muncul kembali di frontend.
  app.get("/api/current-signal", (_req: Request, res: Response) => {
    const snapshot = derivService.getSnapshot();
    const signal = snapshot.currentSignal ?? derivService.getLatestPendingSignal();
    res.json({ signal });
  });

  app.delete("/api/signals", (_req: Request, res: Response) => {
    derivService.clearSignalHistory();
    res.json({ success: true, cleared: true });
  });

  app.post("/api/register-token", (req: Request, res: Response) => {
    const { token } = req.body as { token?: string };
    if (!token) {
      res.status(400).json({ error: "Token required" });
      return;
    }
    derivService.registerToken(token);
    res.json({ success: true, totalTokens: derivService.getTokenCount() });
  });

  app.post("/api/unregister-token", (req: Request, res: Response) => {
    const { token } = req.body as { token?: string };
    if (!token) {
      res.status(400).json({ error: "Token required" });
      return;
    }
    derivService.unregisterToken(token);
    res.json({ success: true, totalTokens: derivService.getTokenCount() });
  });

  // Masalah 5c: Health check endpoint yang lebih lengkap
  app.get("/api/health", (_req: Request, res: Response) => {
    const snapshot = derivService.getSnapshot();
    const lastSignal = derivService.getSignalHistory()[0];
    const lastTickAge = snapshot.lastUpdated
      ? Math.round((Date.now() - new Date(snapshot.lastUpdated).getTime()) / 1000)
      : null;
    const lastSignalAge = lastSignal
      ? Math.round((Date.now() - new Date(lastSignal.timestampUTC).getTime()) / 1000)
      : null;
    res.json({
      status: "ok",
      timestamp: new Date().toUTCString(),
      wsConnected: snapshot.connectionStatus === "connected",
      connectionStatus: snapshot.connectionStatus,
      lastTickAge,
      lastSignalAge,
      m5Count: snapshot.m5CandleCount,
      m15Count: snapshot.m15CandleCount,
      marketOpen: snapshot.marketOpen,
      registeredDevices: derivService.getTokenCount(),
    });
  });

  app.post("/api/test-signal", (_req: Request, res: Response) => {
    const snapshot = derivService.getSnapshot();
    const price = snapshot.currentPrice ?? 5180;
    const fib = snapshot.fibLevels;
    const trend = (snapshot.trend === "Bullish" || snapshot.trend === "Bearish")
      ? snapshot.trend
      : "Bearish";
    const sl = fib ? (trend === "Bearish" ? fib.swingHigh : fib.swingLow) : price + (trend === "Bearish" ? 15 : -15);
    const slDist = Math.abs(price - sl);
    const tp1Dist = Math.min(slDist * 1.0, 15);
    const tp1 = trend === "Bearish" ? price - tp1Dist : price + tp1Dist;
    const extDist = fib ? Math.abs(fib.extensionNeg27 - price) : slDist * 1.8;
    const tp2Dist = Math.min(Math.max(extDist, slDist * 1.8, 10), 28);
    const tp2 = trend === "Bearish" ? price - tp2Dist : price + tp2Dist;
    const rr1 = slDist > 0 ? Math.round((tp1Dist / slDist) * 100) / 100 : 1.0;
    const rr2 = slDist > 0 ? Math.round((tp2Dist / slDist) * 100) / 100 : 1.8;
    derivService.injectTestSignal({ price, trend, sl, tp: tp1, tp2, rr: rr1, rr2 });
    res.json({ ok: true, price, trend, sl, tp1, tp2, rr1, rr2, tokens: derivService.getTokenCount() });
  });

  // ─── SSE Signal Stream (Masalah 4b) ───────────────────────────────────────
  // Frontend subscribe ke endpoint ini untuk menerima sinyal secara real-time
  // tanpa polling 15 detik. Format: event: signal / data: {...TradingSignal}
  app.get("/api/signals/stream", (req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    derivService.addSSEClient(res);

    const flush = () => {
      if (typeof (res as unknown as { flush?: () => void }).flush === "function") {
        (res as unknown as { flush: () => void }).flush();
      }
    };

    const heartbeat = setInterval(() => {
      res.write(": keep-alive\n\n");
      flush();
    }, 20000);

    // Kirim snapshot awal saat connect
    const snapshot = derivService.getSnapshot();
    res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
    flush();

    req.on("close", () => {
      clearInterval(heartbeat);
      derivService.removeSSEClient(res);
    });
  });

  // ─── AI Endpoints ──────────────────────────────────────────────────────────

  // GET /api/ai/messages — Get latest AI messages (for frontend polling)
  app.get("/api/ai/messages", (_req: Request, res: Response) => {
    const limit = parseInt((_req.query.limit as string) ?? "20", 10);
    res.json({ messages: aiService.getMessages(limit), ready: aiService.isReady() });
  });

  // DELETE /api/ai/messages — Clear all AI chat history (conversation + display)
  app.delete("/api/ai/messages", (_req: Request, res: Response) => {
    aiService.clearMessages();
    res.json({ success: true });
  });

  // POST /api/ai/chat — User sends a question, AI processes in background
  app.post("/api/ai/chat", (req: Request, res: Response) => {
    const { message } = req.body as { message?: string };
    if (!message || message.trim().length === 0) {
      res.status(400).json({ error: "Message required" });
      return;
    }
    if (message.trim().length > 500) {
      res.status(400).json({ error: "Pesan terlalu panjang (maks 500 karakter)" });
      return;
    }

    // Masalah 3b: Rate limiting — maks 5 pesan per menit per IP
    const clientKey = req.ip ?? "unknown";
    if (!checkRateLimit(clientKey)) {
      res.status(429).json({ error: "Terlalu banyak pesan. Tunggu 1 menit sebelum mencoba lagi." });
      return;
    }

    const trimmed = message.trim();
    const snapshot = derivService.getSnapshot();
    const requestId = `req_${Date.now()}`;

    // Start AI processing in background — do NOT await
    aiService.chat(trimmed, snapshot, requestId).catch((e: unknown) => {
      console.error("[Routes] Chat background error:", e);
    });

    // Return immediately so the proxy never times out
    res.json({ requestId, queued: true });
  });

  // POST /api/ai/stream — Streaming chat via Server-Sent Events
  app.post("/api/ai/stream", (req: Request, res: Response) => {
    const { message } = req.body as { message?: string };
    if (!message || message.trim().length === 0) {
      res.status(400).json({ error: "Message required" });
      return;
    }
    if (message.trim().length > 500) {
      res.status(400).json({ error: "Pesan terlalu panjang (maks 500 karakter)" });
      return;
    }

    // Masalah 3b: Rate limiting untuk stream endpoint
    const clientKey = req.ip ?? "unknown";
    if (!checkRateLimit(clientKey)) {
      res.status(429).json({ error: "Terlalu banyak pesan. Tunggu 1 menit sebelum mencoba lagi." });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const snapshot = derivService.getSnapshot();

    const flush = () => {
      if (typeof (res as unknown as { flush?: () => void }).flush === "function") {
        (res as unknown as { flush: () => void }).flush();
      }
    };

    let streamDone = false;

    const heartbeat = setInterval(() => {
      if (!streamDone) {
        res.write(": keep-alive\n\n");
        flush();
      }
    }, 5000);

    const clearHeartbeat = () => clearInterval(heartbeat);

    aiService.chatStream(
      message.trim(),
      snapshot,
      (chunk: string) => {
        if (!streamDone) {
          res.write(`event: chunk\ndata: ${JSON.stringify({ chunk })}\n\n`);
          flush();
        }
      },
      (_fullResponse: string, _thinking?: string) => {
        if (!streamDone) {
          streamDone = true;
          clearHeartbeat();
          res.write(`event: done\ndata: [DONE]\n\n`);
          flush();
          res.end();
        }
      },
      (err: string) => {
        console.error("[Routes] Stream error:", err);
        if (!streamDone) {
          streamDone = true;
          clearHeartbeat();
          res.write(`event: error\ndata: ${JSON.stringify({ error: err })}\n\n`);
          flush();
          res.end();
        }
      },
      (thinking: string) => {
        // Full thinking block complete
        if (!streamDone) {
          res.write(`event: thinking\ndata: ${JSON.stringify({ thinking })}\n\n`);
          flush();
        }
      },
      (token: string) => {
        // Live thinking token — streams character by character while AI is thinking
        if (!streamDone) {
          res.write(`event: thinking_token\ndata: ${JSON.stringify({ token })}\n\n`);
          flush();
        }
      }
    );

    res.on("close", () => {
      streamDone = true;
      clearHeartbeat();
    });
  });

  // POST /api/ai/outcome — Frontend reports TP/SL outcome, AI generates commentary
  app.post("/api/ai/outcome", (req: Request, res: Response) => {
    const { signalId, outcome } = req.body as { signalId?: string; outcome?: "win" | "loss" };
    if (!signalId || !outcome || (outcome !== "win" && outcome !== "loss")) {
      res.status(400).json({ error: "signalId and outcome (win|loss) required" });
      return;
    }
    derivService.triggerOutcomeCommentary(signalId, outcome);
    res.json({ ok: true, signalId, outcome });
  });

  const httpServer = createServer(app);
  return httpServer;
}
