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
    await sendLongMessage(ctx, welcomeMessage());
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
    await ctx.reply("🔄 Conversation history reset.");
  });

  /**
   * /new — Alias for /reset
   */
  bot.command("new", async (ctx: Context) => {
    const userId = String(ctx.from?.id ?? "unknown");
    const chatId = String(ctx.chat?.id ?? "unknown");
    log.debug({ userId, chatId }, "Command: new");
    orchestrator.resetConversation(userId, chatId);
    await ctx.reply("🔄 New conversation started.");
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
    await ctx.reply(`Current model: *${provider}* — \`${model}\``, { parse_mode: "Markdown" });
  });

  /**
   * /system — Show the current system prompt
   */
  bot.command("system", async (ctx: Context) => {
    const env = getEnv();
    const systemPrompt = env.SYSTEM_PROMPT || "(default Ayanokōji persona)";
    await sendLongMessage(ctx, `*System Prompt:*\n\n${systemPrompt}`);
  });
}

function welcomeMessage(): string {
  return `*🤖 Boop Agent — Telegram Bot*

I'm an AI assistant with a strategic, analytical mindset. I can help you with research, writing, analysis, coding, and more.

*Commands:*
• /help — Show available commands
• /status — Show bot configuration
• /reset — Reset conversation history
• /model — Show current AI model
• /system — Show current system prompt

Ready when you are.`;
}

function helpMessage(): string {
  return `*📋 Available Commands*

• /start — Welcome message
• /help — Show this help
• /status — Show bot configuration and stats
• /reset — Reset conversation history
• /new — Start a new conversation
• /model — Show current AI model
• /system — Show current system prompt

*Features:*
• Web search with DuckDuckGo (no API key needed) or Tavily
• Web page fetching and summarization
• Save and list drafts
• Memory recall and storage
• Provider-agnostic — supports Anthropic (Claude) and OpenAI

Just send me a message to start chatting.`;
}
