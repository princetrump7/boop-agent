import type { Context } from "telegraf";
import { getEnv, hasTradingConfig } from "../config/env.js";
import type { Logger } from "../config/logger.js";
import { sendLongMessage } from "../telegram/formatting.js";
import { OvernightTradingService } from "./service.js";

/**
 * Direct trading commands (bypass LLM loop).
 * Mirrors overnight_telegram_stock_bot /portfolio /watchlist /status /run_now /exit_now.
 */
export function registerTradingCommands(
  bot: { command: (name: string, handler: (ctx: Context) => Promise<void>) => void },
  logger: Logger,
  injectedService?: OvernightTradingService | null,
): void {
  const log = logger.child({ component: "TradingCommands" });
  const svc = injectedService ?? new OvernightTradingService(log);

  bot.command("portfolio", async (ctx: Context) => {
    await ctx.sendChatAction("typing").catch(() => {});
    try {
      const env = getEnv();
      if (!hasTradingConfig() && env.DRY_RUN) {
        // DRY_RUN without live keys is a demo — still respond instead of hanging on 401s
        const positions = await svc.brokerInstance.getPositions();
        if (positions.length === 0) {
          await ctx.reply("No open positions. (DRY_RUN demo — set ALPACA_API_KEY/SECRET for live/paper data. Use /trading for status.)");
          return;
        }
      } else if (!hasTradingConfig()) {
        await ctx.reply("Trading not configured — set ALPACA_API_KEY and ALPACA_API_SECRET (and ALPACA_PAPER/DRY_RUN) in Render env, then redeploy. Use /trading for current mode.");
        return;
      }
      const positions = await svc.brokerInstance.getPositions();
      if (positions.length === 0) {
        await ctx.reply("No open positions.");
        return;
      }
      const lines = positions.map((p) => `${p.symbol} qty=${p.qty} mv=$${p.market_value} avg=${p.avg_entry_price}`);
      await sendLongMessage(ctx as unknown as Parameters<typeof sendLongMessage>[0], lines.join("\n"));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`Portfolio fetch failed: ${msg.slice(0, 800)}`).catch(() => {});
    }
  });

  bot.command("watchlist", async (ctx: Context) => {
    try {
      const text = await svc.statusText();
      const hint = !hasTradingConfig() ? "\n\n_Alpaca keys not set — showing DRY_RUN demo state. Add ALPACA_API_KEY/SECRET to trade._" : "";
      const lines = text.split("\n").slice(0, 8).join("\n") + hint;
      await sendLongMessage(ctx as unknown as Parameters<typeof sendLongMessage>[0], lines);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`Watchlist failed: ${msg.slice(0, 800)}`).catch(() => {});
    }
  });

  bot.command("status_trading", async (ctx: Context) => {
    await ctx.sendChatAction("typing").catch(() => {});
    try {
      const text = await svc.statusText();
      await sendLongMessage(ctx as unknown as Parameters<typeof sendLongMessage>[0], text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`Status failed: ${msg.slice(0, 800)}`).catch(() => {});
    }
  });

  bot.command("run_now", async (ctx: Context) => {
    // alias for entry run_now — matches overnight bot
    await ctx.sendChatAction("typing").catch(() => {});
    try {
      // In DRY_RUN demo without keys, runEntries now uses a fake $100k account + $150 fallback prices
      // so it will simulate orders (dry-... ids) instead of erroring out.
      const result = await svc.runEntries();
      const lines = [
        `Entries — submitted=${result.submitted} skipped=${result.skipped} failed=${result.failed}`,
        ...result.details.map((d) => `  ${d.symbol} ${d.action} ${d.qty ? `qty=${d.qty} ` : ""}— ${d.reason}`),
      ];
      if (!hasTradingConfig()) lines.push("", "_DRY_RUN demo — no Alpaca keys. Set ALPACA_API_KEY/SECRET to place real paper orders._");
      await sendLongMessage(ctx as unknown as Parameters<typeof sendLongMessage>[0], lines.join("\n"));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`run_now failed: ${msg.slice(0, 800)}`).catch(() => {});
    }
  });

  bot.command("exit_now", async (ctx: Context) => {
    await ctx.sendChatAction("typing").catch(() => {});
    try {
      const result = await svc.runExits();
      const lines = [
        `Exits — submitted=${result.submitted} skipped=${result.skipped} failed=${result.failed}`,
        ...result.details.map((d) => `  ${d.symbol} ${d.action} ${d.qty ? `qty=${d.qty} ` : ""}— ${d.reason}`),
      ];
      if (result.submitted === 0 && result.skipped === 0 && result.failed === 0) {
        lines.push("No entries for today — nothing to exit. Run /run_now first (or wait for the 15:45 CLS window).");
      } else if (!hasTradingConfig()) {
        lines.push("", "_DRY_RUN demo._");
      }
      await sendLongMessage(ctx as unknown as Parameters<typeof sendLongMessage>[0], lines.join("\n"));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`exit_now failed: ${msg.slice(0, 800)}`).catch(() => {});
    }
  });

  // /status is already taken; also support /trading as alias
  bot.command("trading", async (ctx: Context) => {
    try {
      const text = await svc.statusText();
      await sendLongMessage(ctx as unknown as Parameters<typeof sendLongMessage>[0], text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`Trading status failed: ${msg.slice(0, 800)}`).catch(() => {});
    }
  });
}
