import type { Context } from "telegraf";
import type { Logger } from "../config/logger.js";
import { getEnv } from "../config/env.js";
import { sendLongMessage } from "./formatting.js";
import type { Orchestrator } from "../agent/orchestrator.js";

/**
 * Register bot commands.
 */
export function registerCommands(bot: { command: (name: string, handler: (ctx: Context) => Promise<void>) => void }, orchestrator: Orchestrator, logger: Logger): void {
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

    const status = [
      "*🤖 Boop Agent Status*\n",
      `*LLM Provider:* ${provider}`,
      `*Model:* ${model}`,
      `*Convex:* ${convexAvailable}`,
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
   * /system — Show the current system prompt
   */
  bot.command("system", async (ctx: Context) => {
    const env = getEnv();
    const systemPrompt = env.SYSTEM_PROMPT || "(default Ayanokōji persona)";
    await sendLongMessage(ctx, `🧠 *My System Prompt:*\n\n${systemPrompt}`);
  });
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
/system — View, set, or reset the system prompt
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
/system — View, set, or reset the system prompt
/help — Show this help

Give it a try — send me a message! 🚀`;
}
