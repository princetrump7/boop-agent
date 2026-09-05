/**
 * Overnight trading service — TypeScript port of overnight_telegram_stock_bot
 * overnight_bot/service.py OvernightTradingService.
 *
 * Responsibilities:
 *  - Whole-share sizing (floor), gross exposure allocation
 *  - runEntries (CLS buy near close) / runExits (OPG sell near open)
 *  - Status text for Telegram / health
 */
import { getEnv } from "../config/env.js";
import type { Logger } from "../config/logger.js";
import { AlpacaBroker } from "./broker.js";
import { TradeStore } from "./store.js";

export interface ExecutionResult {
  submitted: number;
  skipped: number;
  failed: number;
  details: Array<{ symbol: string; action: string; qty?: number; reason: string }>;
}

function parseSymbols(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

function toTradeDate(d: Date): string {
  // NY trading date, not UTC — matches scheduler's America/New_York ymd
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return fmt.format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

export class OvernightTradingService {
  private broker: AlpacaBroker;
  private store: TradeStore;
  private logger: Logger;

  constructor(logger: Logger, broker?: AlpacaBroker, store?: TradeStore) {
    this.logger = logger.child({ component: "OvernightTradingService" });
    this.broker = broker ?? new AlpacaBroker(this.logger);
    this.store = store ?? new TradeStore(this.logger);
  }

  get brokerInstance(): AlpacaBroker {
    return this.broker;
  }

  get storeInstance(): TradeStore {
    return this.store;
  }

  async statusText(): Promise<string> {
    const env = getEnv();
    const symbols = parseSymbols(env.SYMBOLS ?? "SPY");
    const mode = this.broker.modeLabel;
    const dryRun = env.DRY_RUN ? "true" : "false";
    const paper = env.ALPACA_PAPER ? "PAPER" : "LIVE";
    const account = await this.broker.getAccount().catch(() => null);
    const clock = await this.broker.getClock().catch(() => null);
    const positions = await this.broker.getPositions().catch(() => []);
    const trades = this.store.recent(8);

    const lines: string[] = [];
    const isDemo = !env.ALPACA_API_KEY || !env.ALPACA_API_SECRET;
    lines.push(`*Overnight Bot — ${mode}*  (${paper}, DRY_RUN=${dryRun})${isDemo ? " — demo (no Alpaca keys)" : ""}`);
    lines.push(`Symbols: ${symbols.join(", ")}`);
    lines.push(`Equity/trade: ${env.EQUITY_PER_TRADE_PCT}%  ${env.MAX_TOTAL_EXPOSURE_PCT ? `Max exposure: ${env.MAX_TOTAL_EXPOSURE_PCT}%` : ""}  ${env.MAX_POSITIONS ? `Max positions: ${env.MAX_POSITIONS}` : ""}`.trim());
    if (account) {
      lines.push(`Equity: $${Number(account.equity).toFixed(2)}  Cash: $${Number(account.cash).toFixed(2)}  Buying power: $${Number(account.buying_power).toFixed(2)}${isDemo ? " (demo $100k)" : ""}`);
    } else {
      lines.push(`Account: unavailable (check Alpaca keys)`);
    }
    if (isDemo) {
      lines.push(`ℹ️ Set ALPACA_API_KEY/ALPACA_API_SECRET in Render env to connect a real paper account. DRY_RUN demo uses a $100k mock and $150 fallback prices — /run_now will simulate orders.`);
    }
    if (clock) {
      lines.push(`Market: ${clock.is_open ? "OPEN" : "CLOSED"}  next open ${clock.next_open}  next close ${clock.next_close}`);
    }
    if (positions.length > 0) {
      lines.push(`Positions (${positions.length}):`);
      for (const p of positions.slice(0, 12)) {
        lines.push(`  ${p.symbol} qty=${p.qty} mv=$${p.market_value} avg=${p.avg_entry_price}`);
      }
    } else {
      lines.push(`Positions: none`);
    }
    if (trades.length > 0) {
      lines.push(`Recent trades:`);
      for (const t of trades) {
        lines.push(`  ${t.tradeDate} ${t.symbol} entry=${t.entryStatus}${t.entryQty ? ` qty=${t.entryQty}` : ""}  exit=${t.exitStatus ?? "-"}`);
      }
    }
    lines.push(`Entry window: ${env.ENTRY_MAX_MINUTES_TO_CLOSE} min before close → CLS`);
    lines.push(`Exit window: ${env.EXIT_MIN_MINUTES_TO_OPEN}–${env.EXIT_MAX_MINUTES_TO_OPEN} min after open → OPG`);
    return lines.join("\n");
  }

  /**
   * Submit CLS buys for all symbols for tradeDate (default today ET).
   * Whole-share sizing, idempotent via leased claims.
   */
  async runEntries(
    notify?: (text: string) => Promise<void>,
    tradeDateOverride?: string,
  ): Promise<ExecutionResult> {
    const env = getEnv();
    const symbols = parseSymbols(env.SYMBOLS ?? "SPY");
    const tradeDate = tradeDateOverride ?? toTradeDate(new Date());
    const result: ExecutionResult = { submitted: 0, skipped: 0, failed: 0, details: [] };

    const account = await this.broker.getAccount();
    if (!account) {
      const reason = "account unavailable — check ALPACA_API_KEY/SECRET";
      for (const s of symbols) result.details.push({ symbol: s, action: "buy", reason });
      result.failed = symbols.length;
      await notify?.(`Entry run skipped: ${reason}`);
      return result;
    }

    const equity = Number(account.equity);
    const allocation = (equity * env.EQUITY_PER_TRADE_PCT) / 100;
    const plannedTotal = allocation * symbols.length;
    const positions = await this.broker.getPositions().catch(() => []);
    const existingGross = positions.reduce((sum, p) => sum + Math.abs(Number(p.market_value)), 0);

    if (env.MAX_TOTAL_EXPOSURE_PCT !== undefined) {
      const cap = (equity * env.MAX_TOTAL_EXPOSURE_PCT) / 100;
      if (existingGross + plannedTotal > cap) {
        const reason = `exposure cap ${env.MAX_TOTAL_EXPOSURE_PCT}% ($${cap.toFixed(2)}) would be exceeded (existing $${existingGross.toFixed(2)} + planned $${plannedTotal.toFixed(2)})`;
        for (const s of symbols) result.details.push({ symbol: s, action: "buy", reason });
        result.skipped = symbols.length;
        await notify?.(`Entry run skipped: ${reason}`);
        return result;
      }
    }
    if (env.MAX_POSITIONS !== undefined && positions.length + symbols.length > env.MAX_POSITIONS) {
      const reason = `max positions ${env.MAX_POSITIONS} would be exceeded`;
      for (const s of symbols) result.details.push({ symbol: s, action: "buy", reason });
      result.skipped = symbols.length;
      await notify?.(`Entry run skipped: ${reason}`);
      return result;
    }

    for (const symbol of symbols) {
      const claimed = this.store.claimEntry(tradeDate, symbol);
      if (!claimed) {
        result.skipped++;
        result.details.push({ symbol, action: "buy", reason: "already claimed / already entered today" });
        continue;
      }

      const price = await this.broker.getLatestPrice(symbol);
      if (price === null || price <= 0) {
        this.store.markEntryError(tradeDate, symbol, "no price available");
        result.failed++;
        result.details.push({ symbol, action: "buy", reason: "no price available" });
        continue;
      }

      const qty = Math.floor(allocation / price);
      if (qty < 1) {
        this.store.markEntryError(tradeDate, symbol, `allocation $${allocation.toFixed(2)} too small for price $${price.toFixed(2)}`);
        result.skipped++;
        result.details.push({ symbol, action: "buy", reason: `allocation too small for price $${price.toFixed(2)}` });
        continue;
      }

      try {
        const { order, reused } = await this.broker.submitCloseBuy(symbol, qty, tradeDate, this.store);
        if (!order) {
          this.store.markEntryError(tradeDate, symbol, "order submission failed");
          result.failed++;
          result.details.push({ symbol, action: "buy", qty, reason: "order submission failed" });
          continue;
        }
        const status = reused ? "filled" : order.status;
        this.store.recordEntry(tradeDate, symbol, {
          entryQty: qty,
          entryPrice: price,
          entryOrderId: order.id,
          entryClientOrderId: order.client_order_id,
          entryStatus: this.broker.isDryRun ? "dry_run" : status,
        });
        result.submitted++;
        result.details.push({ symbol, action: "buy", qty, reason: reused ? "reused existing order" : `submitted CLS qty=${qty} @ ~$${price.toFixed(2)}` });
        await notify?.(`Buy ${symbol} qty=${qty} @ ~$${price.toFixed(2)} — ${reused ? "reused" : order.status}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.store.markEntryError(tradeDate, symbol, msg);
        result.failed++;
        result.details.push({ symbol, action: "buy", qty, reason: msg });
      }
    }

    return result;
  }

  /**
   * Submit OPG sells for positions matching tradeDate entries.
   */
  async runExits(
    notify?: (text: string) => Promise<void>,
    tradeDateOverride?: string,
  ): Promise<ExecutionResult> {
    const tradeDate = tradeDateOverride ?? toTradeDate(new Date());
    const rows = this.store.findByDate(tradeDate);
    const result: ExecutionResult = { submitted: 0, skipped: 0, failed: 0, details: [] };

    if (rows.length === 0) {
      await notify?.("No entries for today — nothing to exit.");
      return result;
    }

    const positions = await this.broker.getPositions().catch(() => []);
    const posBySymbol = new Map(positions.map((p) => [p.symbol, p]));

    for (const row of rows) {
      if (row.entryStatus === "error" || row.entryStatus === "claimed") {
        result.skipped++;
        result.details.push({ symbol: row.symbol, action: "sell", reason: `no verified entry (status=${row.entryStatus})` });
        continue;
      }
      if (row.exitStatus && this.store.isTerminalExitStatus(row.exitStatus)) {
        result.skipped++;
        result.details.push({ symbol: row.symbol, action: "sell", reason: `already exited (${row.exitStatus})` });
        continue;
      }

      const pos = posBySymbol.get(row.symbol);
      const qty = row.entryQty ?? (pos ? Math.abs(Number(pos.qty)) : 0);
      if (!qty || qty < 1) {
        const reason = pos ? `no position qty` : "no position";
        this.store.recordExit(tradeDate, row.symbol, { exitStatus: "no_position", exitError: reason });
        result.skipped++;
        result.details.push({ symbol: row.symbol, action: "sell", reason });
        continue;
      }

      try {
        const { order, reused } = await this.broker.submitOpenSell(row.symbol, qty, tradeDate, this.store);
        if (!order) {
          this.store.recordExit(tradeDate, row.symbol, { exitStatus: "error", exitError: "sell submission failed" });
          result.failed++;
          result.details.push({ symbol: row.symbol, action: "sell", qty, reason: "sell submission failed" });
          continue;
        }
        const status = reused ? "filled" : order.status;
        this.store.recordExit(tradeDate, row.symbol, {
          exitQty: qty,
          exitOrderId: order.id,
          exitClientOrderId: order.client_order_id,
          exitStatus: this.broker.isDryRun ? "dry_run" : status,
        });
        result.submitted++;
        result.details.push({ symbol: row.symbol, action: "sell", qty, reason: reused ? "reused existing sell" : `submitted OPG qty=${qty}` });
        await notify?.(`Sell ${row.symbol} qty=${qty} — ${reused ? "reused" : order.status}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.store.recordExit(tradeDate, row.symbol, { exitStatus: "error", exitError: msg });
        result.failed++;
        result.details.push({ symbol: row.symbol, action: "sell", qty, reason: msg });
      }
    }

    return result;
  }
}
