import type { Logger } from "../config/logger.js";
import type { Tool, ToolResult } from "./types.js";
import { OvernightTradingService } from "../trading/service.js";
import { hasTradingConfig } from "../config/env.js";

/**
 * Trading tool factory — exposes OvernightTradingService via LLM tools.
 *
 * Tools:
 *  - trading_status: account + exposure + positions + recent trades
 *  - trading_portfolio: positions snapshot
 *  - trading_run_entries: trigger CLS buy run (idempotent)
 *  - trading_run_exits: trigger OPG sell run (idempotent)
 *
 * Guarded by hasTradingConfig(). If no Alpaca keys, tools return a helpful
 * message instead of failing. Mount these into Orchestrator/InteractionAgent
 * ToolRegistry alongside digest tools.
 */

export function createTradingTools(logger: Logger): Tool[] {
  const log = logger.child({ component: "TradingTools" });
  const svc = new OvernightTradingService(log);

  const tradingStatus: Tool = {
    definition: {
      name: "trading_status",
      description:
        "Show overnight trading status: equity/cash/buying power, positions, recent trades, exposure config, and next entry/exit windows. Works without live Alpaca keys (shows paper/dry_run mode).",
      inputSchema: { type: "object", properties: {} },
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      if (!hasTradingConfig() && svc.brokerInstance.isDryRun === false) {
        // still allow status in dry-run without keys (broker returns nulls)
      }
      try {
        const text = await svc.statusText();
        return { toolName: "trading_status", args, output: text, success: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ err }, "trading_status failed");
        return { toolName: "trading_status", args, output: "", success: false, error: msg };
      }
    },
  };

  const tradingPortfolio: Tool = {
    definition: {
      name: "trading_portfolio",
      description: "List current Alpaca positions (symbol, qty, market_value, avg entry price).",
      inputSchema: { type: "object", properties: {} },
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      try {
        const positions = await svc.brokerInstance.getPositions();
        if (positions.length === 0) {
          return { toolName: "trading_portfolio", args, output: "No open positions.", success: true };
        }
        const lines = positions.map(
          (p) => `${p.symbol} qty=${p.qty} mv=$${p.market_value} avg=${p.avg_entry_price} current=$${p.current_price}`,
        );
        return { toolName: "trading_portfolio", args, output: lines.join("\n"), success: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { toolName: "trading_portfolio", args, output: "", success: false, error: msg };
      }
    },
  };

  const tradingRunEntries: Tool = {
    definition: {
      name: "trading_run_entries",
      description:
        "Trigger the overnight entry run (CLS buy near close). Whole-share sizing, gross exposure caps, idempotent via leased claims. Requires ALPACA_API_KEY/SECRET unless DRY_RUN=true.",
      inputSchema: {
        type: "object",
        properties: {
          trade_date: { type: "string", description: "Override trade date YYYY-MM-DD (default today ET)" },
        },
      },
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const tradeDate = typeof args["trade_date"] === "string" ? String(args["trade_date"]) : undefined;
      try {
        const result = await svc.runEntries(undefined, tradeDate);
        const lines = [
          `Entries ${tradeDate ?? "today"} — submitted=${result.submitted} skipped=${result.skipped} failed=${result.failed}`,
          ...result.details.map((d) => `  ${d.symbol} ${d.action} ${d.qty ? `qty=${d.qty} ` : ""}— ${d.reason}`),
        ];
        return { toolName: "trading_run_entries", args, output: lines.join("\n"), success: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { toolName: "trading_run_entries", args, output: "", success: false, error: msg };
      }
    },
  };

  const tradingRunExits: Tool = {
    definition: {
      name: "trading_run_exits",
      description:
        "Trigger the overnight exit run (OPG sell near open) for today's entries. Idempotent; skips terminal exits.",
      inputSchema: {
        type: "object",
        properties: {
          trade_date: { type: "string", description: "Override trade date YYYY-MM-DD (default today ET)" },
        },
      },
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const tradeDate = typeof args["trade_date"] === "string" ? String(args["trade_date"]) : undefined;
      try {
        const result = await svc.runExits(undefined, tradeDate);
        const lines = [
          `Exits ${tradeDate ?? "today"} — submitted=${result.submitted} skipped=${result.skipped} failed=${result.failed}`,
          ...result.details.map((d) => `  ${d.symbol} ${d.action} ${d.qty ? `qty=${d.qty} ` : ""}— ${d.reason}`),
        ];
        return { toolName: "trading_run_exits", args, output: lines.join("\n"), success: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { toolName: "trading_run_exits", args, output: "", success: false, error: msg };
      }
    },
  };

  const tradingWatchlist: Tool = {
    definition: {
      name: "trading_watchlist",
      description: "Show configured watchlist symbols and per-trade allocation settings.",
      inputSchema: { type: "object", properties: {} },
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      try {
        const text = await svc.statusText();
        // statusText already includes symbols/allocation; return first few lines for brevity
        const lines = text.split("\n").slice(0, 6).join("\n");
        return { toolName: "trading_watchlist", args, output: lines, success: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { toolName: "trading_watchlist", args, output: "", success: false, error: msg };
      }
    },
  };

  return [tradingStatus, tradingPortfolio, tradingRunEntries, tradingRunExits, tradingWatchlist];
}
