import type { Express, Request, Response } from "express";
import { createServer, type Server } from "node:http";
import { derivService } from "./derivService";

export async function registerRoutes(app: Express): Promise<Server> {
  // Current market state — price, trend, EMA, Fibonacci, active signal
  app.get("/api/market-state", (_req: Request, res: Response) => {
    res.json(derivService.getSnapshot());
  });

  // Signal history — all detected signals this session
  app.get("/api/signals", (_req: Request, res: Response) => {
    res.json(derivService.getSignalHistory());
  });

  // Register push token — called by app on startup to enable background notifications
  app.post("/api/register-token", (req: Request, res: Response) => {
    const { token } = req.body as { token?: string };
    if (!token) {
      res.status(400).json({ error: "Token required" });
      return;
    }
    derivService.registerToken(token);
    res.json({ success: true, totalTokens: derivService.getTokenCount() });
  });

  // Unregister push token — called when user disables notifications
  app.post("/api/unregister-token", (req: Request, res: Response) => {
    const { token } = req.body as { token?: string };
    if (!token) {
      res.status(400).json({ error: "Token required" });
      return;
    }
    derivService.unregisterToken(token);
    res.json({ success: true, totalTokens: derivService.getTokenCount() });
  });

  // Health check
  app.get("/api/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      timestamp: new Date().toUTCString(),
      registeredDevices: derivService.getTokenCount(),
    });
  });

  // Debug: force emit a test signal to all registered push tokens
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

  const httpServer = createServer(app);
  return httpServer;
}
