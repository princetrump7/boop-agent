/**
 * Trade store — JSON-file persistence with leased claims.
 *
 * Faithful port of overnight_telegram_stock_bot overnight_bot/database.py
 * TradeRepository semantics, but without better-sqlite3. Uses a single JSON
 * file at DB_PATH (default bot.db.json) with WAL-like atomic writes
 * (write to temp + rename). Idempotent claim semantics are preserved:
 *  - claimEntry(tradeDate, symbol, ttlSec=900) returns true only for the
 *    first caller; stale leases (> TTL) are reclaimable.
 *  - recordEntry / markEntryError / recordExit update the claimed row.
 *  - UNIQUE(trade_date, symbol) + leased-at in-memory expiry.
 */
import fs from "node:fs";
import path from "node:path";
import { getEnv } from "../config/env.js";
import type { Logger } from "../config/logger.js";

const TERMINAL_EXIT_STATUSES = new Set([
  "dry_run",
  "no_position",
  "consolidated",
  "mode_mismatch",
  "no_verified_entry",
  "entry_not_accepted",
]);

export interface TradeRow {
  id: number;
  tradeDate: string;
  symbol: string;
  entryQty?: number | null;
  entryPrice?: number | null;
  entryOrderId?: string | null;
  entryClientOrderId?: string | null;
  entryStatus: string; // "claimed" | "filled" | "error" | "dry_run" | ...
  entryError?: string | null;
  exitQty?: number | null;
  exitPrice?: number | null;
  exitOrderId?: string | null;
  exitClientOrderId?: string | null;
  exitStatus?: string | null;
  exitError?: string | null;
  claimedAt: string; // ISO
  createdAt: string;
  updatedAt: string;
}

type StoreFile = { rows: TradeRow[]; nextId: number };

export class TradeStore {
  private filePath: string;
  private logger: Logger;
  private mem: StoreFile = { rows: [], nextId: 1 };

  constructor(logger: Logger, filePath?: string) {
    this.logger = logger.child({ component: "TradeStore" });
    this.filePath = filePath ?? this.resolvePath();
    this.load();
  }

  private resolvePath(): string {
    try {
      const env = getEnv();
      const raw = env.DB_PATH ?? "bot.db";
      // Normalize to .json if it looks like sqlite
      if (raw.endsWith(".db")) return `${raw}.json`;
      return raw;
    } catch {
      return "bot.db.json";
    }
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as StoreFile;
      if (Array.isArray(parsed.rows) && typeof parsed.nextId === "number") {
        this.mem = parsed;
      }
    } catch (err) {
      this.logger.warn({ err, filePath: this.filePath }, "TradeStore load failed — starting empty");
      this.mem = { rows: [], nextId: 1 };
    }
  }

  private persist(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (dir && dir !== ".") fs.mkdirSync(dir, { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.mem, null, 2), "utf-8");
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      this.logger.error({ err, filePath: this.filePath }, "TradeStore persist failed");
    }
  }

  private isStale(row: TradeRow, ttlSec: number): boolean {
    const claimed = new Date(row.claimedAt).getTime();
    if (Number.isNaN(claimed)) return true;
    return Date.now() - claimed > ttlSec * 1000;
  }

  /** Claim an entry slot for (tradeDate, symbol). Returns true if this caller won the claim. */
  claimEntry(tradeDate: string, symbol: string, ttlSec = 900): boolean {
    const existing = this.mem.rows.find((r) => r.tradeDate === tradeDate && r.symbol === symbol);
    if (!existing) {
      const now = new Date().toISOString();
      const row: TradeRow = {
        id: this.mem.nextId++,
        tradeDate,
        symbol,
        entryStatus: "claimed",
        claimedAt: now,
        createdAt: now,
        updatedAt: now,
      };
      this.mem.rows.push(row);
      this.persist();
      return true;
    }
    // Already claimed — allow reclaim only if stale and still in non-terminal entry
    if (existing.entryStatus === "claimed" && this.isStale(existing, ttlSec)) {
      existing.claimedAt = new Date().toISOString();
      existing.updatedAt = new Date().toISOString();
      this.persist();
      return true;
    }
    // Already has a terminal/filled entry — not claimable
    return false;
  }

  recordEntry(
    tradeDate: string,
    symbol: string,
    fields: {
      entryQty?: number;
      entryPrice?: number | null;
      entryOrderId?: string;
      entryClientOrderId?: string;
      entryStatus?: string;
    },
  ): void {
    const row = this.mem.rows.find((r) => r.tradeDate === tradeDate && r.symbol === symbol);
    if (!row) return;
    if (fields.entryQty !== undefined) row.entryQty = fields.entryQty;
    if (fields.entryPrice !== undefined) row.entryPrice = fields.entryPrice;
    if (fields.entryOrderId !== undefined) row.entryOrderId = fields.entryOrderId;
    if (fields.entryClientOrderId !== undefined) row.entryClientOrderId = fields.entryClientOrderId;
    if (fields.entryStatus !== undefined) row.entryStatus = fields.entryStatus;
    row.updatedAt = new Date().toISOString();
    this.persist();
  }

  markEntryError(tradeDate: string, symbol: string, error: string): void {
    const row = this.mem.rows.find((r) => r.tradeDate === tradeDate && r.symbol === symbol);
    if (!row) return;
    row.entryStatus = "error";
    row.entryError = error;
    row.updatedAt = new Date().toISOString();
    this.persist();
  }

  recordExit(
    tradeDate: string,
    symbol: string,
    fields: {
      exitQty?: number;
      exitPrice?: number | null;
      exitOrderId?: string;
      exitClientOrderId?: string;
      exitStatus: string;
      exitError?: string | null;
    },
  ): void {
    const row = this.mem.rows.find((r) => r.tradeDate === tradeDate && r.symbol === symbol);
    if (!row) return;
    if (fields.exitQty !== undefined) row.exitQty = fields.exitQty;
    if (fields.exitPrice !== undefined) row.exitPrice = fields.exitPrice;
    if (fields.exitOrderId !== undefined) row.exitOrderId = fields.exitOrderId;
    if (fields.exitClientOrderId !== undefined) row.exitClientOrderId = fields.exitClientOrderId;
    row.exitStatus = fields.exitStatus;
    row.exitError = fields.exitError ?? null;
    row.updatedAt = new Date().toISOString();
    this.persist();
  }

  findByDate(tradeDate: string): TradeRow[] {
    return this.mem.rows
      .filter((r) => r.tradeDate === tradeDate)
      .sort((a, b) => a.symbol.localeCompare(b.symbol));
  }

  recent(limit = 20): TradeRow[] {
    return [...this.mem.rows]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  all(): TradeRow[] {
    return [...this.mem.rows];
  }

  /** Whether an exit status is terminal (no retry). */
  isTerminalExitStatus(status: string): boolean {
    return TERMINAL_EXIT_STATUSES.has(status);
  }
}
