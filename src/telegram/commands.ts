import type { Context } from "telegraf";
import type { Logger } from "../config/logger.js";
import { getEnv } from "../config/env.js";
import { sendLongMessage } from "./formatting.js";
import type { Orchestrator } from "../agent/orchestrator.js";
import type { SystemPromptStore } from "../agent/system-prompt.js";
import { defaultSystemPrompt } from "../agent/providers/base.js";

/**
 * Register bot commands.
 */
export function registerCommands(
  bot: { command: (name: string, handler: (ctx: Context) => Promise<void>) => void },
  orchestrator: Orchestrator,
  systemPromptStore: SystemPromptStore,
  logger: Logger,
): void {
  const log = logger.child({ component: "Commands" });

  /**
   * /start — Welcome message
   */
  bot.command("start", async (ctx: Context) => {
    log.debug({ userId: ctx.from?.id }, "Command: start");
    const name = ctx.from?.first_name || ctx.from?.username || "there";
    await sendLongMessage(ctx, welcomeMessage(name));
  });

  /**
   * /help — Show available commands
   */
  bot.command("help", async (ctx: Context) => {
    log.debug({ userId: ctx.from?.id }, "Command: help");
    await sendLongMessage(ctx, helpMessage());
  });

  /**
   * /status — Show current configuration and stats
   */
  bot.command("status", async (ctx: Context) => {
    log.debug({ userId: ctx.from?.id }, "Command: status");
    const env = getEnv();
    const provider = env.LLM_PROVIDER ?? "anthropic";
    const model = provider === "openai"
      ? (env.OPENAI_MODEL ?? "gpt-4o")
      : (env.ANTHROPIC_MODEL ?? "claude-sonnet-4-20250514");
    const convexAvailable = env.CONVEX_URL ? "Yes" : "No (in-memory mode)";
    const chatId = String(ctx.chat?.id ?? "unknown");
    const customPrompt = await systemPromptStore.get(chatId);
    const promptSource = customPrompt
      ? "Custom (this chat)"
      : env.SYSTEM_PROMPT
        ? "Environment (SYSTEM_PROMPT)"
        : "Default persona";

    const status = [
      "*🤖 Boop Agent Status*\n",
      `*LLM Provider:* ${provider}`,
      `*Model:* ${model}`,
      `*Convex:* ${convexAvailable}`,
      `*System Prompt:* ${promptSource}`,
      `*Prompt Storage:* ${systemPromptStore.backend}`,
      `*Tools:* ${orchestrator.getToolRegistry().size} registered`,
      `*Authorized Users:* ${env.AUTHORIZED_USER_ID || env.AUTHORIZED_USER_IDS || "None configured"}`,
    ].join("\n");

    await sendLongMessage(ctx, status);
  });

  /**
   * /reset — Reset conversation history for this chat
   */
  bot.command("reset", async (ctx: Context) => {
    const userId = String(ctx.from?.id ?? "unknown");
    const chatId = String(ctx.chat?.id ?? "unknown");
    log.debug({ userId, chatId }, "Command: reset");
    orchestrator.resetConversation(userId, chatId);
    await ctx.reply("🧹 *Poof!* History reset. What's on your mind? 🤔", { parse_mode: "Markdown" });
  });

  /**
   * /new — Alias for /reset
   */
  bot.command("new", async (ctx: Context) => {
    const userId = String(ctx.from?.id ?? "unknown");
    const chatId = String(ctx.chat?.id ?? "unknown");
    log.debug({ userId, chatId }, "Command: new");
    orchestrator.resetConversation(userId, chatId);
    await ctx.reply("✨ Fresh slate! Ready when you are. 🚀");
  });

  /**
   * /model — Show current model
   */
  bot.command("model", async (ctx: Context) => {
    const env = getEnv();
    const provider = env.LLM_PROVIDER ?? "anthropic";
    const model = provider === "openai"
      ? (env.OPENAI_MODEL ?? "gpt-4o")
      : (env.ANTHROPIC_MODEL ?? "claude-sonnet-4-20250514");
    await ctx.reply(`🎯 I'm running on *${provider}* with \`${model}\``, { parse_mode: "Markdown" });
  });

  /**
   * /system — View, set, or reset the system prompt for this chat.
   *
   * Usage:
   *   /system                → show the effective system prompt
   *   /system set <prompt>   → set a custom system prompt for this chat
   *   /system <prompt>       → shorthand for `set`
   *   /system reset          → clear the custom prompt (back to env/default)
   */
  bot.command("system", async (ctx: Context) => {
    const env = getEnv();
    const chatId = String(ctx.chat?.id ?? "unknown");
    const args = extractCommandArgs(ctx);

    // No arguments → show the current effective system prompt
    if (!args) {
      const custom = await systemPromptStore.get(chatId);
      const effective = custom ?? env.SYSTEM_PROMPT ?? defaultSystemPrompt();
      const source = custom
        ? "Custom (this chat)"
        : env.SYSTEM_PROMPT
          ? "Environment (SYSTEM_PROMPT)"
          : "Built-in default";

      await sendLongMessage(
        ctx,
        `🧠 *System Prompt*\n\n*Source:* ${source}\n*Chat:* \`${chatId}\`\n\n${effective}\n\n---\n_Set a new one with \`/system set <prompt>\` or reset with \`/system reset\`._`,
      );
      return;
    }

    // Reserved sub-commands
    if (args === "reset" || args === "clear" || args === "default") {
      await systemPromptStore.clear(chatId);
      log.debug({ chatId }, "System prompt reset");
      await ctx.reply(
        "♻️ *System prompt reset.* I'm back to the environment or default persona.",
        { parse_mode: "Markdown" },
      );
      return;
    }

    if (args === "help") {
      await ctx.reply(
        "🧠 *System Prompt Commands*\n\n" +
          "`/system` — show the current prompt\n" +
          "`/system set <prompt>` — set a custom prompt for this chat\n" +
          "`/system reset` — clear the custom prompt\n\n" +
          "The custom prompt is saved per chat and persists across restarts when Convex is configured.",
        { parse_mode: "Markdown" },
      );
      return;
    }

    // "set <prompt>" → strip the prefix
    const prompt = args.startsWith("set ")
      ? args.slice(4).trim()
      : args;

    if (!prompt) {
      await ctx.reply(
        "⚠️ Please include a prompt, e.g. `/system set You are a pirate.`",
        { parse_mode: "Markdown" },
      );
      return;
    }

    await systemPromptStore.set(chatId, prompt);
    log.debug({ chatId }, "System prompt updated");
    await ctx.reply(
      `✅ *System prompt updated for this chat.*\n\n${prompt}\n\nUse \`/system\` to view it or \`/system reset\` to revert.`,
      { parse_mode: "Markdown" },
    );
  });
}

/**
 * Extract the arguments that follow a Telegram command.
 *
 * Handles both `/system set foo` and `/system@MyBot set foo`, returning
 * the raw remainder (e.g. `set foo`) or "" when there are no arguments.
 */
function extractCommandArgs(ctx: Context): string {
  const text = ctx.message && "text" in ctx.message ? ctx.message.text : "";
  return text.replace(/^\/\w+(?:@\w+)?\s*/, "").trim();
}

function welcomeMessage(name: string): string {
  return `👋 Hey ${name}! I'm your *Boop agent*.

I can help you research, answer questions, and perform tasks using AI. Here's what I support:

🤖 *Agent Chat* — Send me any message and I'll respond with AI
🔍 *Web Search* — I can search the web for current info
🧠 *Memory* — I remember facts you tell me
✅ *Safe Mode* — Dangerous actions wait for your approval

Commands:
/start — Show this message
/new — Start a fresh conversation
/model — Check or switch the active AI model
/system — View the system prompt
/system set <prompt> — Change the system prompt
/system reset — Restore the default prompt
/help — Get detailed help`;
}

function helpMessage(): string {
  return `📋 *How to use your Boop agent*

Just send me any message and I'll respond with AI-powered help. Here's what I can do:

🤖 *Agent Chat* — Ask me anything! Research, coding, writing, analysis.
🔍 *Web Search* — I can look up current info from the web for you.
🧠 *Memory* — Tell me something to remember and I'll keep it for later.
✅ *Safe Mode* — I'll ask for approval before doing anything risky.

Commands:
/start — Show the welcome message
/new — Start a fresh conversation
/model — Check or switch the active AI model
/system — View the current system prompt
/system set <prompt> — Set a custom system prompt for this chat
/system reset — Clear the custom prompt (back to default)
/help — Show this help

Give it a try — send me a message! 🚀`;
}
