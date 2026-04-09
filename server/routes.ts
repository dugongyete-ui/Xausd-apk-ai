import type { Express, Request, Response } from "express";
import { createServer, type Server } from "node:http";
import { derivService } from "./derivService";
import { aiService } from "./aiService";

export async function registerRoutes(app: Express): Promise<Server> {
  app.get("/api/market-state", (_req: Request, res: Response) => {
    res.json(derivService.getSnapshot());
  });

  app.get("/api/signals", (_req: Request, res: Response) => {
    res.json(derivService.getSignalHistory());
  });

  // GET /api/current-signal — returns the most recent signal (pending or just resolved)
  // Used by frontend polling to track active trade state and receive TP/SL outcomes.
  // Fallback: jika currentSignal null (mis. setelah restart sebelum candle baru),
  // kembalikan sinyal pending terbaru dari history yang sudah di-persist.
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

  app.get("/api/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      timestamp: new Date().toUTCString(),
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

  // ─── AI Endpoints ──────────────────────────────────────────────────────────

  // GET /api/ai/messages — Get latest AI messages (for frontend polling)
  app.get("/api/ai/messages", (_req: Request, res: Response) => {
    const limit = parseInt((_req.query.limit as string) ?? "20", 10);
    res.json({ messages: aiService.getMessages(limit), ready: aiService.isReady() });
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
          res.write(`data: ${JSON.stringify({ chunk })}\n\n`);
          flush();
        }
      },
      (_fullResponse: string) => {
        if (!streamDone) {
          streamDone = true;
          clearHeartbeat();
          res.write(`data: [DONE]\n\n`);
          flush();
          res.end();
        }
      },
      (err: string) => {
        console.error("[Routes] Stream error:", err);
        if (!streamDone) {
          streamDone = true;
          clearHeartbeat();
          res.write(`data: ${JSON.stringify({ error: err })}\n\n`);
          flush();
          res.end();
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
