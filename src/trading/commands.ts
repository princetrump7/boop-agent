import type { Context } from "telegraf";
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
): void {
  const log = logger.child({ component: "TradingCommands" });
  const svc = new OvernightTradingService(log);

  bot.command("portfolio", async (ctx: Context) => {
    await ctx.sendChatAction("typing").catch(() => {});
    try {
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
      const lines = text.split("\n").slice(0, 8).join("\n");
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
      const result = await svc.runEntries();
      const lines = [
        `Entries — submitted=${result.submitted} skipped=${result.skipped} failed=${result.failed}`,
        ...result.details.map((d) => `  ${d.symbol} ${d.action} ${d.qty ? `qty=${d.qty} ` : ""}— ${d.reason}`),
      ];
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
