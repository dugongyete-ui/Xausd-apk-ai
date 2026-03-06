import fs from "fs";
import path from "path";
import type { TradingSignal } from "./derivService";

const STORE_PATH = path.resolve("data/signals.json");
const MAX_STORED = 500;

export function loadSignals(): TradingSignal[] {
  try {
    if (!fs.existsSync(STORE_PATH)) return [];
    const raw = fs.readFileSync(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as TradingSignal[];
    if (!Array.isArray(parsed)) return [];
    console.log(`[SignalStore] Loaded ${parsed.length} signals from disk`);
    return parsed;
  } catch (e) {
    console.warn("[SignalStore] Load failed:", (e as Error).message);
    return [];
  }
}

export function saveSignals(signals: TradingSignal[]): void {
  try {
    const dir = path.dirname(STORE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const toSave = signals.slice(0, MAX_STORED);
    fs.writeFileSync(STORE_PATH, JSON.stringify(toSave), "utf8");
  } catch (e) {
    console.error("[SignalStore] Save failed:", (e as Error).message);
  }
}

export function clearAllSignals(): void {
  try {
    const dir = path.dirname(STORE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify([]), "utf8");
    console.log("[SignalStore] All signals cleared from disk");
  } catch (e) {
    console.error("[SignalStore] Clear failed:", (e as Error).message);
  }
}
