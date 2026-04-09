/**
 * server/signalStore.ts
 * Masalah 2a: Migrasi dari JSON file ke SQLite (better-sqlite3)
 * Masalah 2b: Error handling + validasi schema
 */
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import type { TradingSignal } from "./derivService";

const DB_DIR  = path.resolve("data");
const DB_PATH = path.join(DB_DIR, "signals.db");

let db: Database.Database;

function getDb(): Database.Database {
  if (db) return db;
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS signals (
      id              TEXT PRIMARY KEY,
      pair            TEXT NOT NULL,
      trend           TEXT NOT NULL,
      entryPrice      REAL NOT NULL,
      stopLoss        REAL NOT NULL,
      takeProfit      REAL NOT NULL,
      takeProfit2     REAL,
      riskReward      REAL NOT NULL,
      riskReward2     REAL,
      lotSize         REAL NOT NULL,
      timestampUTC    TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'active',
      signalCandleEpoch INTEGER NOT NULL,
      confirmationType TEXT NOT NULL,
      outcome         TEXT DEFAULT 'pending',
      sessionTag      TEXT,
      effectiveSL     REAL,
      confluence      INTEGER,
      marketRegime    TEXT,
      fibLevels       TEXT,
      createdAt       INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
  console.log("[SignalStore] SQLite database initialised:", DB_PATH);
  return db;
}

// ─── Validation ───────────────────────────────────────────────────────────────
function isValidSignal(s: unknown): s is TradingSignal {
  if (!s || typeof s !== "object") return false;
  const o = s as Record<string, unknown>;
  return (
    typeof o.id          === "string" &&
    typeof o.entryPrice  === "number" &&
    typeof o.stopLoss    === "number" &&
    typeof o.takeProfit  === "number" &&
    typeof o.trend       === "string" &&
    typeof o.timestampUTC === "string"
  );
}

// ─── Load ─────────────────────────────────────────────────────────────────────
export function loadSignals(): TradingSignal[] {
  try {
    const database = getDb();

    // Migration: jika JSON lama masih ada, import ke SQLite lalu hapus
    const legacyJson = path.resolve("data/signals.json");
    if (fs.existsSync(legacyJson)) {
      try {
        const raw = fs.readFileSync(legacyJson, "utf8");
        const legacy = JSON.parse(raw) as TradingSignal[];
        if (Array.isArray(legacy) && legacy.length > 0) {
          console.log(`[SignalStore] Migrating ${legacy.length} signals from JSON to SQLite...`);
          const insertMany = database.transaction((rows: TradingSignal[]) => {
            for (const s of rows) {
              if (!isValidSignal(s)) continue;
              try {
                upsertSignal(database, s);
              } catch {}
            }
          });
          insertMany(legacy);
          console.log("[SignalStore] Migration complete.");
        }
        fs.renameSync(legacyJson, legacyJson + ".migrated");
      } catch (migErr) {
        console.warn("[SignalStore] Migration warning:", (migErr as Error).message);
      }
    }

    const rows = database.prepare(
      "SELECT * FROM signals ORDER BY createdAt DESC LIMIT 500"
    ).all() as Record<string, unknown>[];

    const signals = rows.map(rowToSignal).filter(isValidSignal);
    const pending  = signals.filter((s) => !s.outcome || s.outcome === "pending").length;
    const resolved = signals.filter((s) => s.outcome === "win" || s.outcome === "loss").length;
    console.log(`[SignalStore] Loaded ${signals.length} signals from SQLite (${resolved} resolved, ${pending} pending)`);
    return signals;
  } catch (e) {
    console.error("[SignalStore] Load failed:", (e as Error).message);
    return [];
  }
}

// ─── Save (upsert all) ────────────────────────────────────────────────────────
export function saveSignals(signals: TradingSignal[]): void {
  try {
    const database = getDb();
    const upsertAll = database.transaction((rows: TradingSignal[]) => {
      for (const s of rows.slice(0, 500)) {
        if (!isValidSignal(s)) continue;
        upsertSignal(database, s);
      }
    });
    upsertAll(signals);
  } catch (e) {
    console.error("[SignalStore] Save failed:", (e as Error).message);
  }
}

// ─── Clear ────────────────────────────────────────────────────────────────────
export function clearAllSignals(): void {
  try {
    const database = getDb();
    database.prepare("DELETE FROM signals").run();
    console.log("[SignalStore] All signals cleared from SQLite");
  } catch (e) {
    console.error("[SignalStore] Clear failed:", (e as Error).message);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function upsertSignal(database: Database.Database, s: TradingSignal): void {
  database.prepare(`
    INSERT INTO signals (
      id, pair, trend, entryPrice, stopLoss, takeProfit, takeProfit2,
      riskReward, riskReward2, lotSize, timestampUTC, status,
      signalCandleEpoch, confirmationType, outcome, sessionTag,
      effectiveSL, confluence, marketRegime, fibLevels
    ) VALUES (
      @id, @pair, @trend, @entryPrice, @stopLoss, @takeProfit, @takeProfit2,
      @riskReward, @riskReward2, @lotSize, @timestampUTC, @status,
      @signalCandleEpoch, @confirmationType, @outcome, @sessionTag,
      @effectiveSL, @confluence, @marketRegime, @fibLevels
    )
    ON CONFLICT(id) DO UPDATE SET
      outcome      = excluded.outcome,
      effectiveSL  = excluded.effectiveSL,
      status       = excluded.status
  `).run({
    id:               s.id,
    pair:             s.pair,
    trend:            s.trend,
    entryPrice:       s.entryPrice,
    stopLoss:         s.stopLoss,
    takeProfit:       s.takeProfit,
    takeProfit2:      s.takeProfit2 ?? null,
    riskReward:       s.riskReward,
    riskReward2:      s.riskReward2 ?? null,
    lotSize:          s.lotSize,
    timestampUTC:     s.timestampUTC,
    status:           s.status,
    signalCandleEpoch: s.signalCandleEpoch,
    confirmationType: s.confirmationType,
    outcome:          s.outcome ?? "pending",
    sessionTag:       s.sessionTag ?? null,
    effectiveSL:      s.effectiveSL ?? null,
    confluence:       s.confluence ? 1 : 0,
    marketRegime:     s.marketRegime ?? null,
    fibLevels:        s.fibLevels ? JSON.stringify(s.fibLevels) : null,
  });
}

function rowToSignal(row: Record<string, unknown>): TradingSignal {
  return {
    id:               String(row.id),
    pair:             String(row.pair),
    timeframe:        "M15/M5",
    trend:            row.trend as "Bullish" | "Bearish",
    entryPrice:       Number(row.entryPrice),
    stopLoss:         Number(row.stopLoss),
    takeProfit:       Number(row.takeProfit),
    takeProfit2:      row.takeProfit2 != null ? Number(row.takeProfit2) : undefined,
    riskReward:       Number(row.riskReward),
    riskReward2:      row.riskReward2 != null ? Number(row.riskReward2) : undefined,
    lotSize:          Number(row.lotSize),
    timestampUTC:     String(row.timestampUTC),
    status:           (row.status as "active" | "closed") ?? "active",
    signalCandleEpoch: Number(row.signalCandleEpoch),
    confirmationType: row.confirmationType as "rejection" | "engulfing",
    outcome:          (row.outcome as "win" | "loss" | "pending" | "expired") ?? "pending",
    sessionTag:       row.sessionTag as "active" | "low_confidence" | undefined,
    effectiveSL:      row.effectiveSL != null ? Number(row.effectiveSL) : undefined,
    confluence:       Boolean(row.confluence),
    marketRegime:     row.marketRegime as "trending" | "ranging" | "unknown" | undefined,
    fibLevels:        row.fibLevels ? JSON.parse(String(row.fibLevels)) : {
      swingHigh: 0, swingLow: 0, level618: 0, level786: 0, extensionNeg27: 0
    },
  };
}
