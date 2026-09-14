/**
 * Simulated paper broker — free replacement for Tradier/Alpaca.
 *
 * - No external brokerage keys required. Uses Yahoo Finance (no key) for
 *   real prices, optional FINNHUB_API_KEY fallback, and deterministic
 *   hash fallback (80-400) so getLatestPrice never returns null when
 *   offline.
 * - Local NY clock (America/New_York) computed via Intl.DateTimeFormat;
 *   no Tradier /markets/clock fetch.
 * - In-memory Maps for orders/positions persisted atomically to
 *   paper-broker.json alongside TradeStore bot.db.json (tmp+rename+fsync).
 * - Same exported types/aliases and public methods as TradierBroker so
 *   OvernightTradingService, commands and LLM tools keep importing
 *   { TradierBroker } / { AlpacaBroker } unchanged.
 * - Idempotency via tag overnight-buy-{date}-{symbol} /
 *   overnight-sell-{date}-{symbol} backed by local orders Map
 *   (findOrderByClientId) and TradeStore claim guards.
 * - Whole-share simulation: buys deduct cash and create/average positions;
 *   sells reduce positions and credit cash immediately (filled).
 * - DRY_RUN respected for modeLabel/isDryRun/status strings but positions
 *   still simulate (so /run_now works out of the box).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getEnv } from "../config/env.js";
import type { Logger } from "../config/logger.js";
import type { TradeStore } from "./store.js";

// ── Preserved exported types (so callers never break) ──────────────
export type OrderSide = "buy" | "sell";
export type OrderType = "market" | "limit";
export type TimeInForce = "day" | "cls" | "opg" | "gtc";
export type OrderStatus =
  | "new"
  | "accepted"
  | "pending_new"
  | "filled"
  | "canceled"
  | "rejected"
  | "expired";

export interface AlpacaOrder {
  id: string;
  client_order_id: string;
  symbol: string;
  qty: string;
  side: OrderSide;
  type: OrderType;
  time_in_force: TimeInForce;
  status: OrderStatus;
  created_at: string;
}

export interface AlpacaPosition {
  symbol: string;
  qty: string;
  market_value: string;
  cost_basis: string;
  avg_entry_price: string;
  current_price: string;
}

export interface AlpacaAccount {
  id: string;
  equity: string;
  buying_power: string;
  cash: string;
  status: string;
}

export interface BrokerClock {
  is_open: boolean;
  next_open: string;
  next_close: string;
  timestamp: string;
}

// Tradier aliases (callers use these names)
export type TradierOrder = AlpacaOrder;
export type TradierPosition = AlpacaPosition;
export type TradierAccount = AlpacaAccount;

// ── Helpers ─────────────────────────────────────────────────────────

function deterministicPrice(symbol: string): number {
  let h = 0;
  for (let i = 0; i < symbol.length; i++) h = (Math.imul(31, h) + symbol.charCodeAt(i)) | 0;
  const abs = Math.abs(h);
  const base = 80 + (abs % 320); // 80-399
  const cents = (abs % 100) / 100; // 0.00-0.99
  return Number((base + cents).toFixed(2));
}

function paperPath(): string {
  try {
    const env = getEnv();
    const raw = (env.DB_PATH as string) || "bot.db.json";
    const dir = path.dirname(raw);
    if (!dir || dir === "." || dir === "") return "paper-broker.json";
    return path.join(dir, "paper-broker.json");
  } catch {
    return "paper-broker.json";
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

type PaperPersistShape = {
  cash: number;
  orders: AlpacaOrder[];
  positions: AlpacaPosition[];
};

// ── Yahoo / Finnhub price helpers (free) ───────────────────────────

async function yahooQuotePrice(symbol: string, logger?: Logger): Promise<number | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "boop-agent/0.3 paper-sim", Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    } as RequestInit);
    if (!res.ok) return null;
    const j: unknown = await res.json();
    const r = (j as { quoteResponse?: { result?: Array<Record<string, unknown>> } })?.quoteResponse?.result?.[0];
    if (!r) return null;
    const candidates = [
      r["regularMarketPrice"],
      r["postMarketPrice"],
      r["bid"],
      r["ask"],
      r["regularMarketPreviousClose"],
    ];
    for (const c of candidates) if (typeof c === "number" && isFinite(c) && c > 0) return c;
    return null;
  } catch (e) {
    logger?.debug({ err: String(e), symbol }, "yahoo quote failed");
    return null;
  }
}

async function yahooChartPrice(symbol: string, logger?: Logger): Promise<number | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
    const res = await fetch(url, {
      headers: { "User-Agent": "boop-agent/0.3 paper-sim", Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    } as RequestInit);
    if (!res.ok) return null;
    const j: unknown = await res.json();
    const result = (j as { chart?: { result?: Array<{ meta?: Record<string, unknown> }> } })?.chart?.result?.[0];
    const meta = result?.meta as Record<string, unknown> | undefined;
    if (!meta) return null;
    const candidates = [meta["regularMarketPrice"], meta["previousClose"], meta["chartPreviousClose"]];
    for (const c of candidates) if (typeof c === "number" && isFinite(c) && c > 0) return c as number;
    return null;
  } catch (e) {
    logger?.debug({ err: String(e), symbol }, "yahoo chart failed");
    return null;
  }
}

async function finnhubPrice(symbol: string, logger?: Logger): Promise<number | null> {
  try {
    const env = getEnv();
    const key = (env.FINNHUB_API_KEY as string | undefined)?.trim();
    if (!key) return null;
    const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(key)}`;
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    } as RequestInit);
    if (!res.ok) return null;
    const j = (await res.json()) as Record<string, unknown>;
    const c = j["c"];
    if (typeof c === "number" && isFinite(c) && c > 0) return c;
    return null;
  } catch (e) {
    logger?.debug({ err: String(e), symbol }, "finnhub failed");
    return null;
  }
}

async function batchYahooQuotes(symbols: string[], logger?: Logger): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (symbols.length === 0) return out;
  for (let i = 0; i < symbols.length; i += 50) {
    const chunk = symbols.slice(i, i + 50);
    try {
      const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(chunk.join(","))}`;
      const res = await fetch(url, {
        headers: { "User-Agent": "boop-agent/0.3 paper-sim", Accept: "application/json" },
        signal: AbortSignal.timeout(6000),
      } as RequestInit);
      if (!res.ok) continue;
      const j: unknown = await res.json();
      const arr = (j as { quoteResponse?: { result?: Array<Record<string, unknown>> } })?.quoteResponse?.result ?? [];
      for (const r of arr) {
        const sym = String(r["symbol"] ?? "").toUpperCase();
        const candidates = [r["regularMarketPrice"], r["bid"], r["ask"], r["regularMarketPreviousClose"]] as unknown[];
        for (const c of candidates) {
          if (typeof c === "number" && isFinite(c) && c > 0) {
            out.set(sym, c);
            break;
          }
        }
      }
    } catch (e) {
      logger?.debug({ err: String(e) }, "batch yahoo failed");
    }
  }
  return out;
}

// ── NY clock (local, no Tradier) ───────────────────────────────────

function nyClock(): BrokerClock {
  const now = new Date();
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const hour = Number(get("hour"));
    const minute = Number(get("minute"));
    const weekday = get("weekday");
    const isWeekday = !["Sat", "Sun"].includes(weekday);
    const mins = hour * 60 + minute;
    const isOpen = isWeekday && mins >= 570 && mins < 960;
    const ymd = `${get("year")}-${get("month")}-${get("day")}`;
    const nextOpen = isOpen ? `${ymd} 09:30 ET (open)` : `next trading day 09:30 ET`;
    const nextClose = isOpen ? `${ymd} 16:00 ET` : `${ymd} 16:00 ET (when open)`;
    return {
      is_open: isOpen,
      next_open: nextOpen,
      next_close: nextClose,
      timestamp: now.toISOString(),
    };
  } catch {
    return { is_open: false, next_open: "09:30 ET", next_close: "16:00 ET", timestamp: now.toISOString() };
  }
}

// ── Simulated paper broker ─────────────────────────────────────────

export class PaperBroker {
  private readonly logger: Logger;
  private readonly filePath: string;
  private cash: number;
  private orders: Map<string, AlpacaOrder>;
  private positions: Map<string, AlpacaPosition>;
  private initialEquity: number;

  constructor(logger: Logger) {
    this.logger = logger.child ? logger.child({ component: "PaperBroker" }) : logger;
    this.filePath = paperPath();
    this.orders = new Map();
    this.positions = new Map();
    let paperEquity = 100000;
    try {
      paperEquity = Number((getEnv() as Record<string, unknown>).PAPER_EQUITY ?? 100000);
      if (!isFinite(paperEquity) || paperEquity <= 0) paperEquity = 100000;
    } catch {
      paperEquity = 100000;
    }
    this.initialEquity = paperEquity;
    this.cash = paperEquity;
    this.loadFromDisk();
  }

  get modeLabel(): string {
    try {
      const env = getEnv() as Record<string, unknown>;
      const dry = Boolean(env.DRY_RUN);
      if (dry) return "DRY_RUN";
      return "PAPER";
    } catch {
      return "PAPER";
    }
  }

  get isDryRun(): boolean {
    try {
      return Boolean((getEnv() as Record<string, unknown>).DRY_RUN);
    } catch {
      return true;
    }
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = fs.readFileSync(this.filePath, "utf8");
      if (!raw.trim()) return;
      const parsed = JSON.parse(raw) as PaperPersistShape;
      if (typeof parsed.cash === "number" && isFinite(parsed.cash)) this.cash = parsed.cash;
      if (Array.isArray(parsed.orders)) {
        for (const o of parsed.orders) if (o?.client_order_id) this.orders.set(o.client_order_id, o);
      }
      if (Array.isArray(parsed.positions)) {
        for (const p of parsed.positions) if (p?.symbol) this.positions.set(p.symbol.toUpperCase(), p);
      }
      this.logger.debug?.({ file: this.filePath, orders: this.orders.size, positions: this.positions.size }, "paper broker loaded");
    } catch (e) {
      this.logger.warn?.({ err: String(e), file: this.filePath }, "paper broker load failed — starting fresh");
    }
  }

  private persist(): void {
    try {
      const shape: PaperPersistShape = {
        cash: this.cash,
        orders: [...this.orders.values()],
        positions: [...this.positions.values()],
      };
      const dir = path.dirname(this.filePath);
      if (dir && dir !== "." && dir !== "") fs.mkdirSync(dir, { recursive: true });
      const tmp = `${this.filePath}.tmp.${process.pid}.${Date.now()}`;
      fs.writeFileSync(tmp, JSON.stringify(shape, null, 2), "utf8");
      try {
        const fd = fs.openSync(tmp, "r");
        try {
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        // fsync best-effort
      }
      fs.renameSync(tmp, this.filePath);
    } catch (e) {
      this.logger.warn?.({ err: String(e), file: this.filePath }, "paper broker persist failed");
    }
  }

  private equityNow(): number {
    let mv = 0;
    for (const p of this.positions.values()) mv += Number(p.market_value) || 0;
    return this.cash + mv;
  }

  async getAccount(): Promise<AlpacaAccount | null> {
    const equity = this.equityNow();
    return {
      id: "paper-sim",
      equity: String(equity),
      buying_power: String(this.cash),
      cash: String(this.cash),
      status: "ACTIVE",
    };
  }

  async getClock(): Promise<BrokerClock> {
    return nyClock();
  }

  async getPositions(): Promise<AlpacaPosition[]> {
    if (this.positions.size === 0) return [];
    const syms = [...this.positions.keys()];
    const quotes = await batchYahooQuotes(syms, this.logger).catch(() => new Map<string, number>());
    const out: AlpacaPosition[] = [];
    for (const [sym, pos] of this.positions.entries()) {
      const live = quotes.get(sym);
      const qtyNum = Number(pos.qty) || 0;
      if (live && live > 0) {
        const mv = qtyNum * live;
        out.push({ ...pos, current_price: String(live), market_value: String(Number(mv.toFixed(2))) });
      } else {
        const cp = Number(pos.current_price) || Number(pos.avg_entry_price) || deterministicPrice(sym);
        const mv = qtyNum * cp;
        out.push({ ...pos, current_price: String(cp), market_value: String(Number(mv.toFixed(2))) });
      }
    }
    return out;
  }

  async getLatestPrice(symbol: string): Promise<number | null> {
    const sym = symbol.toUpperCase().trim();
    if (!sym) return null;
    const q1 = await yahooQuotePrice(sym, this.logger);
    if (q1 !== null) return q1;
    const q2 = await yahooChartPrice(sym, this.logger);
    if (q2 !== null) return q2;
    const q3 = await finnhubPrice(sym, this.logger);
    if (q3 !== null) return q3;
    return deterministicPrice(sym);
  }

  async findOrderByClientId(clientOrderId: string): Promise<AlpacaOrder | null> {
    return this.orders.get(clientOrderId) ?? null;
  }

  private async submitIdempotent(
    payload: { symbol: string; side: OrderSide; qty: number; tag: string; type: OrderType; duration: string },
    _store?: TradeStore,
  ): Promise<{ order: AlpacaOrder | null; reused: boolean }> {
    const tag = payload.tag;
    const existing = await this.findOrderByClientId(tag);
    if (existing) return { order: existing, reused: true };

    const sym = payload.symbol.toUpperCase();
    const qty = Math.floor(payload.qty);
    if (qty < 1) return { order: null, reused: false };

    const price = (await this.getLatestPrice(sym)) ?? deterministicPrice(sym);
    const now = nowIso();

    if (payload.side === "buy") {
      const cost = qty * price;
      if (this.cash < cost) {
        this.logger.warn?.({ symbol: sym, qty, price, cash: this.cash }, "paper buy exceeding cash — allowing (paper)");
      }
      this.cash -= cost;
      const existingPos = this.positions.get(sym);
      if (existingPos) {
        const prevQty = Number(existingPos.qty) || 0;
        const prevCost = Number(existingPos.cost_basis) || 0;
        const newQty = prevQty + qty;
        const newCost = prevCost + cost;
        const newAvg = newQty > 0 ? newCost / newQty : price;
        this.positions.set(sym, {
          symbol: sym,
          qty: String(newQty),
          cost_basis: String(Number(newCost.toFixed(2))),
          avg_entry_price: String(Number(newAvg.toFixed(2))),
          current_price: String(price),
          market_value: String(Number((newQty * price).toFixed(2))),
        });
      } else {
        this.positions.set(sym, {
          symbol: sym,
          qty: String(qty),
          cost_basis: String(Number(cost.toFixed(2))),
          avg_entry_price: String(Number(price.toFixed(2))),
          current_price: String(price),
          market_value: String(Number((qty * price).toFixed(2))),
        });
      }
    } else {
      const pos = this.positions.get(sym);
      const proceeds = qty * price;
      if (!pos) {
        this.cash += proceeds;
      } else {
        const prevQty = Number(pos.qty) || 0;
        const sellQty = Math.min(qty, prevQty);
        const remaining = prevQty - sellQty;
        this.cash += sellQty * price;
        if (remaining <= 0) {
          this.positions.delete(sym);
        } else {
          const prevCost = Number(pos.cost_basis) || 0;
          const avg = Number(pos.avg_entry_price) || price;
          const newCost = Math.max(0, prevCost - sellQty * avg);
          this.positions.set(sym, {
            symbol: sym,
            qty: String(remaining),
            cost_basis: String(Number(newCost.toFixed(2))),
            avg_entry_price: String(Number(avg.toFixed(2))),
            current_price: String(price),
            market_value: String(Number((remaining * price).toFixed(2))),
          });
        }
      }
    }

    const isDry = this.isDryRun;
    const order: AlpacaOrder = {
      id: `${isDry ? "dry" : "paper"}-${tag}-${Date.now()}`,
      client_order_id: tag,
      symbol: sym,
      qty: String(qty),
      side: payload.side,
      type: payload.type,
      time_in_force: "day",
      status: "filled",
      created_at: now,
    };
    this.orders.set(tag, order);
    this.persist();
    return { order, reused: false };
  }

  async submitCloseBuy(
    symbol: string,
    qty: number,
    tradeDate: string,
    store?: TradeStore,
  ): Promise<{ order: AlpacaOrder | null; reused: boolean }> {
    const tag = `overnight-buy-${tradeDate}-${symbol.toUpperCase()}`;
    return this.submitIdempotent({ symbol, side: "buy", qty, tag, type: "market", duration: "day" }, store);
  }

  async submitOpenSell(
    symbol: string,
    qty: number,
    tradeDate: string,
    store?: TradeStore,
  ): Promise<{ order: AlpacaOrder | null; reused: boolean }> {
    const tag = `overnight-sell-${tradeDate}-${symbol.toUpperCase()}`;
    return this.submitIdempotent({ symbol, side: "sell", qty, tag, type: "market", duration: "day" }, store);
  }
}

// ── Back-compat aliases (callers import TradierBroker / AlpacaBroker) ──
export const TradierBroker = PaperBroker;
export type TradierBroker = PaperBroker;
export const AlpacaBroker = PaperBroker;
export type AlpacaBroker = PaperBroker;
export const SimulatedPaperBroker = PaperBroker;
export const PaperSim = PaperBroker;
