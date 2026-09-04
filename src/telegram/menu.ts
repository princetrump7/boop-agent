import { Markup } from "telegraf";
import type { Context } from "telegraf";
import type { Logger } from "../config/logger.js";
import { getEnv } from "../config/env.js";
import type { EnvConfig } from "../config/env.js";
import { escapeMarkdown } from "./formatting.js";
import type { Orchestrator } from "../agent/orchestrator.js";
import type { SystemPromptStore } from "../agent/system-prompt.js";

/**
 * Boop's interactive control panel.
 *
 * One message that morphs in place as you tap buttons — the modern
 * Telegram pattern. Every screen is a pure text+keyboard builder below,
 * and callbacks swap screens by editing the same message.
 */

interface Panel {
  text: string;
  keyboard: ReturnType<typeof Markup.inlineKeyboard>;
}

// ── Screen builders (pure — unit-testable) ──────────────────────────────

const NAV_ROW = [
  Markup.button.callback("🏠 Home", "menu:home"),
  Markup.button.callback("✕ Close", "menu:close"),
];

export function homePanel(name?: string): Panel {
  const who = name ? `Hey ${escapeMarkdown(name)} — ` : "";
  return {
    text:
      `✦ *Boop*\n\n${who}your AI agent on Telegram.\n\n` +
      "Everything is one tap away — this panel updates in place.",
    keyboard: Markup.inlineKeyboard([
      [
        Markup.button.callback("🆕 New chat", "menu:new"),
        Markup.button.callback("✨ What I can do", "menu:capabilities"),
      ],
      [
        Markup.button.callback("🎭 My persona", "menu:persona"),
        Markup.button.callback("🎯 Model", "menu:model"),
      ],
      [
        Markup.button.callback("🗞️ Digest", "menu:digest"),
        Markup.button.callback("📈 Trading", "menu:trading"),
      ],
      [
        Markup.button.callback("📊 Status", "menu:status"),
        Markup.button.callback("💡 Pro tips", "menu:tips"),
      ],
      NAV_ROW,
    ]),
  };
}

export function capabilitiesPanel(): Panel {
  return {
    text:
      "✨ *What I can do*\n\n" +
      "🔗 *Links* — paste any URL, I read what's actually there\n" +
      "▶️ *YouTube* — videos give me title, channel and full transcript\n" +
      "📄 *Files* — send PDF / txt / md / code / JSON right in chat\n" +
      "🔍 *Web search* — current events, prices, scores\n" +
      "🧠 *Memory* — facts you want kept across chats\n" +
      "🔐 *Approvals* — risky actions wait for your OK",
    keyboard: Markup.inlineKeyboard([NAV_ROW]),
  };
}

export function tipsPanel(): Panel {
  return {
    text:
      "💡 *Pro tips*\n\n" +
      "• Link + question in one message works best:\n" +
      "  `summarize this for a 12-year-old <link>`\n" +
      "• Caption a file with your question — I'll treat it as the task\n" +
      "• Long transcripts? Ask for `key takeaways` or `only the quotes about X`\n" +
      "• `/new` clears context when switching topics\n" +
      "• Make me anyone: `/system set You are a blunt startup coach.`",
    keyboard: Markup.inlineKeyboard([NAV_ROW]),
  };
}

export function personaPanel(source: string, prompt: string): Panel {
  const excerpt =
    prompt.length > 350 ? `${prompt.slice(0, 350).trimEnd()}…` : prompt || "(default persona)";
  return {
    text:
      `🎭 *My persona*\n\n${escapeMarkdown(excerpt)}\n\n` +
      `*Source* — ${source}\n\n` +
      "Make me anyone:\n`/system set You are a blunt startup coach.`\n" +
      "`/system reset` brings back the default.",
    keyboard: Markup.inlineKeyboard([NAV_ROW]),
  };
}

export function modelPanel(provider: string, model: string): Panel {
  return {
    text: `🎯 *Model*\n\n*Provider* — ${provider}\n*Model* — \`${model}\``,
    keyboard: Markup.inlineKeyboard([NAV_ROW]),
  };
}

export function statusPanel(env: EnvConfig, toolsCount: number, backend: string): Panel {
  const extras: string[] = [];
  if (typeof env.TELEGRAM_API_ID !== "undefined" || (env as Record<string, unknown>).SESSION_B64) {
    extras.push(`*Digest* — MTProto ${env.TELEGRAM_API_ID ? "configured" : "Bot-API fallback"}`);
    extras.push(`*Auto-digest* — ${env.AUTO_DIGEST_HOUR != null ? `${String(env.AUTO_DIGEST_HOUR).padStart(2, "0")}:00 ${env.TIMEZONE}` : "off"}`);
  }
  if ((env as Record<string, unknown>).ALPACA_API_KEY) {
    const mode = (env as Record<string, unknown>).DRY_RUN ? "DRY_RUN" : (env as Record<string, unknown>).ALPACA_PAPER ? "paper" : "live";
    extras.push(`*Trading* — ${mode} · ${(env as Record<string, unknown>).SYMBOLS ?? ""}`);
  }
  return {
    text:
      "📊 *Status*\n\n" +
      `*Provider* — ${env.LLM_PROVIDER ?? "anthropic"}\n` +
      `*Persistence* — ${env.CONVEX_URL ? "Convex" : "In-memory"}\n` +
      `*Tools* — ${toolsCount} registered\n` +
      `*Prompt storage* — ${backend}` +
      (extras.length ? `\n${extras.join("\n")}` : ""),
    keyboard: Markup.inlineKeyboard([NAV_ROW]),
  };
}

export function digestPanel(env: EnvConfig): Panel {
  const mode = env.TELEGRAM_API_ID ? "MTProto (full dialogs)" : "Bot-API (bot-seen chats only)";
  return {
    text:
      "🗞️ *Digest*\n\n" +
      `*Mode* — ${mode}\n` +
      `*Window* — ${env.DEFAULT_HOURS}h · ${env.MAX_CHATS} chats · ${env.MAX_MESSAGES} msgs/chat\n` +
      `*Auto* — ${env.AUTO_DIGEST_HOUR != null ? `${String(env.AUTO_DIGEST_HOUR).padStart(2, "0")}:00 ${env.TIMEZONE} daily` : "off (set AUTO_DIGEST_HOUR)"}\n\n` +
      "Try:\n`/digest 24` · `/chats` · `/chat <name> 24` · `/ask what was decided? 24` · `/join <invite link>`",
    keyboard: Markup.inlineKeyboard([NAV_ROW]),
  };
}

export function tradingPanel(env: EnvConfig): Panel {
  const hasKeys = Boolean((env as Record<string, unknown>).ALPACA_API_KEY);
  const mode = hasKeys ? ((env as Record<string, unknown>).DRY_RUN ? "DRY_RUN (no orders)" : (env as Record<string, unknown>).ALPACA_PAPER ? "paper" : "LIVE") : "not configured";
  return {
    text:
      "📈 *Overnight Trading*\n\n" +
      `*Mode* — ${mode}\n` +
      `*Watchlist* — ${(env as Record<string, unknown>).SYMBOLS ?? "SPY"}\n` +
      `*Schedule* — 15:45 CLS buy · 19:05 OPG sell (America/New_York, Mon–Fri)\n` +
      `*Allocation* — ${env.EQUITY_PER_TRADE_PCT}% equity/trade` +
      (env.MAX_TOTAL_EXPOSURE_PCT ? ` · cap ${env.MAX_TOTAL_EXPOSURE_PCT}%` : "") +
      (env.MAX_POSITIONS ? ` · max ${env.MAX_POSITIONS} positions` : "") +
      "\n\n" +
      "Try:\n`/portfolio` · `/watchlist` · `/trading` · `/run_now` · `/exit_now`",
    keyboard: Markup.inlineKeyboard([NAV_ROW]),
  };
}

// ── Wiring ───────────────────────────────────────────────────────────────

export function registerMenu(
  bot: {
    command: (name: string, handler: (ctx: Context) => Promise<void>) => void;
    action: (pattern: RegExp, handler: (ctx: Context) => Promise<void>) => void;
  },
  orchestrator: Orchestrator,
  systemPromptStore: SystemPromptStore,
  logger: Logger,
): void {
  const log = logger.child({ component: "Menu" });

  /** Send (or replace with) a screen. Falls back to a fresh reply if editing fails. */
  const show = async (ctx: Context, panel: Panel, viaAnswer: boolean): Promise<void> => {
    try {
      await ctx.editMessageText(panel.text, { parse_mode: "Markdown", ...panel.keyboard });
    } catch {
      try {
        await ctx.reply(panel.text, { parse_mode: "Markdown", ...panel.keyboard });
      } catch {
        // Message may be too old to touch at all — drop silently.
      }
    }
    if (viaAnswer) await ctx.answerCbQuery().catch(() => {});
  };

  // /menu — open the panel (fresh command → send, don't edit)
  bot.command("menu", async (ctx: Context) => {
    log.debug({ userId: ctx.from?.id }, "Command: menu");
    const panel = homePanel(ctx.from?.first_name ?? ctx.from?.username);
    await ctx.reply(panel.text, { parse_mode: "Markdown", ...panel.keyboard });
  });

  // All panel navigation lives under the "menu:" callback namespace.
  bot.action(/^menu:(home|new|persona|model|status|tips|capabilities|digest|trading|close)$/, async (ctx) => {
    const action = (ctx as unknown as { match: RegExpExecArray | undefined }).match?.[1] ?? "home";

    try {
      switch (action) {
        case "close": {
          await ctx.deleteMessage().catch(() => {});
          await ctx.answerCbQuery("Closed").catch(() => {});
          return;
        }
        case "home":
          await show(ctx, homePanel(), true);
          break;
        case "capabilities":
          await show(ctx, capabilitiesPanel(), true);
          break;
        case "tips":
          await show(ctx, tipsPanel(), true);
          break;
        case "new": {
          const userId = String(ctx.from?.id ?? "unknown");
          const chatId = String(ctx.chat?.id ?? "unknown");
          orchestrator.resetConversation(userId, chatId);
          await show(
            ctx,
            {
              text: "🆕 *Fresh start.*\n\nConversation cleared — what's next?",
              keyboard: Markup.inlineKeyboard([NAV_ROW]),
            },
            true,
          );
          break;
        }
        case "persona": {
          const chatId = String(ctx.chat?.id ?? "unknown");
          const env = getEnv();
          const custom = await systemPromptStore.get(chatId);
          const source = custom
            ? "Custom (this chat)"
            : env.SYSTEM_PROMPT
              ? "Environment"
              : "Default";
          await show(ctx, personaPanel(source, custom ?? env.SYSTEM_PROMPT ?? ""), true);
          break;
        }
        case "model": {
          const env = getEnv();
          const provider = env.LLM_PROVIDER ?? "anthropic";
          const model =
            provider === "openai"
              ? (env.OPENAI_MODEL ?? "gpt-4o")
              : (env.ANTHROPIC_MODEL ?? "claude-sonnet-4-20250514");
          await show(ctx, modelPanel(provider, model), true);
          break;
        }
        case "status":
          await show(
            ctx,
            statusPanel(getEnv(), orchestrator.getToolRegistry().size, systemPromptStore.backend),
            true,
          );
          break;
        case "digest":
          await show(ctx, digestPanel(getEnv()), true);
          break;
        case "trading":
          await show(ctx, tradingPanel(getEnv()), true);
          break;
      }
    } catch (err) {
      log.error({ err, action }, "Menu callback failed");
      await ctx.answerCbQuery("Something went wrong").catch(() => {});
    }
  });
}
