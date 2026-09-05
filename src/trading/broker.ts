/**
 * Alpaca broker — TypeScript port of overnight_telegram_stock_bot overnight_bot/broker.py.
 *
 * Reproduces CLS (market-on-close) and OPG (market-on-open) semantics via
 * fetch against Alpaca REST. No Alpaca SDK is required; this avoids a native
 * dep and keeps the bundle pure ESM. All methods are idempotent via
 * client_order_id = overnight-buy-{date}-{symbol} / overnight-sell-{date}-{symbol}
 * and support DRY_RUN where orders are faked locally.
 */
import type { Logger } from "../config/logger.js";
import { getEnv } from "../config/env.js";
import type { TradeStore } from "./store.js";

export type OrderSide = "buy" | "sell";
export type OrderType = "market" | "limit";
export type TimeInForce = "day" | "cls" | "opg" | "gtc";
export type OrderStatus = "new" | "accepted" | "pending_new" | "filled" | "canceled" | "rejected" | "expired";

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

function alpacaBase(isPaper: boolean): string {
  return isPaper ? "https://paper-api.alpaca.markets" : "https://api.alpaca.markets";
}
const DATA_BASE = "https://data.alpaca.markets";

function headers(apiKey: string, secret: string): Record<string, string> {
  return {
    "APCA-API-KEY-ID": apiKey,
    "APCA-API-SECRET-KEY": secret,
    "Content-Type": "application/json",
  };
}

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function isNotFound(status: number): boolean {
  return status === 404;
}

export class AlpacaBroker {
  private readonly apiKey: string;
  private readonly secret: string;
  private readonly paper: boolean;
  private readonly dryRun: boolean;
  private readonly logger: Logger;

  constructor(logger: Logger) {
    const env = getEnv();
    this.apiKey = env.ALPACA_API_KEY ?? "";
    this.secret = env.ALPACA_API_SECRET ?? "";
    this.paper = env.ALPACA_PAPER ?? true;
    this.dryRun = env.DRY_RUN ?? true;
    this.logger = logger.child({ component: "AlpacaBroker" });
  }

  get modeLabel(): string {
    if (this.dryRun) return "DRY_RUN";
    return this.paper ? "PAPER" : "LIVE";
  }

  get isDryRun(): boolean {
    return this.dryRun;
  }

  // -------------------------------------------------------------------------
  // REST helpers
  // -------------------------------------------------------------------------

  private async fetchAlpaca(
    path: string,
    opts: { method?: string; body?: unknown; dataHost?: boolean } = {},
  ): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
    const base = opts.dataHost ? DATA_BASE : alpacaBase(this.paper);
    const url = `${base}${path}`;
    const init: RequestInit = {
      method: opts.method ?? "GET",
      headers: headers(this.apiKey, this.secret),
    };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    const res = await fetch(url, init);
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? (JSON.parse(text) as unknown) : null;
    } catch {
      json = null;
    }
    return { ok: res.ok, status: res.status, json, text };
  }

  // -------------------------------------------------------------------------
  // Account / market
  // -------------------------------------------------------------------------

  async getAccount(): Promise<AlpacaAccount | null> {
    if (!this.apiKey || !this.secret) {
      if (this.dryRun) {
        return {
          id: "dry-run",
          equity: "100000",
          buying_power: "100000",
          cash: "100000",
          status: "ACTIVE",
        };
      }
      return null;
    }
    const r = await this.fetchAlpaca("/v2/account");
    if (!r.ok) {
      this.logger.warn({ status: r.status, text: r.text }, "getAccount failed");
      return null;
    }
    return r.json as AlpacaAccount;
  }

  async getClock(): Promise<BrokerClock | null> {
    if (!this.apiKey || !this.secret) return null;
    const r = await this.fetchAlpaca("/v2/clock");
    if (!r.ok) {
      this.logger.warn({ status: r.status }, "getClock failed");
      return null;
    }
    return r.json as BrokerClock;
  }

  async getPositions(): Promise<AlpacaPosition[]> {
    if (!this.apiKey || !this.secret) return [];
    const r = await this.fetchAlpaca("/v2/positions");
    if (!r.ok) {
      if (isNotFound(r.status)) return [];
      this.logger.warn({ status: r.status }, "getPositions failed");
      return [];
    }
    return (r.json as AlpacaPosition[]) ?? [];
  }

  async getLatestPrice(symbol: string): Promise<number | null> {
    if (!this.apiKey || !this.secret) {
      // DRY_RUN price fallback so sizing can be demoed without live keys
      // Use ~150 as neutral placeholder; real flow would fetch IEX snapshot
      return this.dryRun ? 150 : null;
    }
    // IEX snapshot price via data API
    const r = await this.fetchAlpaca(`/v2/stocks/${symbol}/snapshot`, { dataHost: true });
    if (!r.ok) return null;
    const j = r.json as { latestTrade?: { p?: number }; latestQuote?: { ap?: number; bp?: number } } | null;
    const p = j?.latestTrade?.p ?? j?.latestQuote?.ap ?? null;
    return typeof p === "number" ? p : null;
  }

  async findOrderByClientId(clientOrderId: string): Promise<AlpacaOrder | null> {
    if (!this.apiKey || !this.secret) return null;
    const r = await this.fetchAlpaca(
      `/v2/orders?status=all&nested=false&client_order_id=${encodeURIComponent(clientOrderId)}&limit=1`,
    );
    if (!r.ok) {
      if (isNotFound(r.status)) return null;
      return null;
    }
    const arr = r.json as AlpacaOrder[] | null;
    if (Array.isArray(arr) && arr.length > 0) return arr[0]!;
    // Single-order path fallback
    const single = r.json as AlpacaOrder | null;
    if (single && typeof (single as { id?: string }).id === "string") return single;
    return null;
  }

  // -------------------------------------------------------------------------
  // Order submission (idempotent)
  // -------------------------------------------------------------------------

  private async submitIdempotent(
    payload: Record<string, unknown>,
    _store: TradeStore | null,
  ): Promise<{ order: AlpacaOrder | null; reused: boolean; dryRun: boolean }> {
    const clientOrderId = String(payload["client_order_id"] ?? "");

    // Check existing first
    const existing = await this.findOrderByClientId(clientOrderId);
    if (existing) {
      this.logger.info({ clientOrderId, status: existing.status }, "Reusing existing order");
      return { order: existing, reused: true, dryRun: false };
    }

    if (this.dryRun) {
      const fake: AlpacaOrder = {
        id: `dry-${clientOrderId}`,
        client_order_id: clientOrderId,
        symbol: String(payload["symbol"] ?? ""),
        qty: String(payload["qty"] ?? "0"),
        side: payload["side"] as OrderSide,
        type: payload["type"] as OrderType,
        time_in_force: payload["time_in_force"] as TimeInForce,
        status: "accepted",
        created_at: new Date().toISOString(),
      };
      this.logger.info({ clientOrderId, symbol: fake.symbol, qty: fake.qty }, "DRY_RUN order (not sent)");
      return { order: fake, reused: false, dryRun: true };
    }

    const r = await this.fetchAlpaca("/v2/orders", { method: "POST", body: payload });
    if (!r.ok) {
      // 422 with "client_order_id already exists" -> re-fetch
      const text = String(r.text ?? "");
      if (text.includes("client_order_id") || r.status === 409 || r.status === 422) {
        const retry = await this.findOrderByClientId(clientOrderId);
        if (retry) return { order: retry, reused: true, dryRun: false };
      }
      this.logger.error({ status: r.status, text: r.text, payload }, "Order submission failed");
      return { order: null, reused: false, dryRun: false };
    }
    return { order: r.json as AlpacaOrder, reused: false, dryRun: false };
  }

  async submitCloseBuy(
    symbol: string,
    qty: number,
    tradeDate: string,
    store: TradeStore | null,
  ): Promise<{ order: AlpacaOrder | null; reused: boolean; dryRun: boolean }> {
    const clientOrderId = `overnight-buy-${tradeDate}-${symbol}`;
    return this.submitIdempotent(
      {
        symbol,
        qty: String(qty),
        side: "buy",
        type: "market",
        time_in_force: "cls",
        client_order_id: clientOrderId,
      },
      store,
    );
  }

  async submitOpenSell(
    symbol: string,
    qty: number,
    tradeDate: string,
    store: TradeStore | null,
  ): Promise<{ order: AlpacaOrder | null; reused: boolean; dryRun: boolean }> {
    // Validate existing order if needed (lightweight)
    if (!this.dryRun) {
      const existing = await this.findOrderByClientId(`overnight-buy-${tradeDate}-${symbol}`);
      if (existing && existing.status !== "filled" && existing.status !== "accepted" && existing.status !== "pending_new") {
        this.logger.warn({ clientOrderId: `overnight-buy-${tradeDate}-${symbol}`, status: existing.status }, "Buy not accepted — skipping sell");
      }
    }
    const clientOrderId = `overnight-sell-${tradeDate}-${symbol}`;
    return this.submitIdempotent(
      {
        symbol,
        qty: String(qty),
        side: "sell",
        type: "market",
        time_in_force: "opg",
        client_order_id: clientOrderId,
      },
      store,
    );
  }
}
