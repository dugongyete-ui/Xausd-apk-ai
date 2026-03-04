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
    const tp = fib ? fib.extensionNeg27 : price - (trend === "Bearish" ? 20 : -20);
    const slDist = Math.abs(price - sl);
    const tpDist = Math.abs(tp - price);
    const rr = slDist > 0 ? Math.round((tpDist / slDist) * 100) / 100 : 1.5;
    derivService.injectTestSignal({ price, trend, sl, tp, rr });
    res.json({ ok: true, price, trend, sl, tp, rr, tokens: derivService.getTokenCount() });
  });

  // ─── AI Endpoints ──────────────────────────────────────────────────────────

  // GET /api/ai/messages — Get latest AI messages (for frontend polling)
  app.get("/api/ai/messages", (_req: Request, res: Response) => {
    const limit = parseInt((_req.query.limit as string) ?? "20", 10);
    res.json({ messages: aiService.getMessages(limit), ready: aiService.isReady() });
  });

  // POST /api/ai/chat — User sends a question to AI
  app.post("/api/ai/chat", async (req: Request, res: Response) => {
    const { message } = req.body as { message?: string };
    if (!message || message.trim().length === 0) {
      res.status(400).json({ error: "Message required" });
      return;
    }
    if (message.trim().length > 500) {
      res.status(400).json({ error: "Pesan terlalu panjang (maks 500 karakter)" });
      return;
    }
    const snapshot = derivService.getSnapshot();
    const response = await aiService.chat(message.trim(), snapshot);
    res.json({ response, messages: aiService.getMessages(20) });
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
