import type { Context } from "telegraf";
import type { Logger } from "../config/logger.js";
import { getEnv } from "../config/env.js";
import type { EnvConfig } from "../config/env.js";
import { sendLongMessage, escapeMarkdown, kv, commandList } from "./formatting.js";
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
    const name = escapeMarkdown(ctx.from?.first_name || ctx.from?.username || "there");
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
    const { provider, model } = activeModel(env);
    const chatId = String(ctx.chat?.id ?? "unknown");
    const customPrompt = await systemPromptStore.get(chatId);
    const promptSource = customPrompt
      ? "Custom (this chat)"
      : env.SYSTEM_PROMPT
        ? "Environment"
        : "Default";

    const lines = [
      kv("Provider", provider),
      kv("Model", `\`${model}\``),
      kv("Persistence", env.CONVEX_URL ? "Convex" : "In-memory"),
      kv("System prompt", promptSource),
      kv("Prompt storage", systemPromptStore.backend),
      kv("Tools", `${orchestrator.getToolRegistry().size} registered`),
      kv(
        "Authorized users",
        String(env.AUTHORIZED_USER_ID || env.AUTHORIZED_USER_IDS || "None configured"),
      ),
    ];

    await sendLongMessage(
      ctx,
      `📊 *Status*\n\n${lines.join("\n")}\n\nOpen \`/menu\` for quick actions.`,
    );
  });

  /**
   * /reset — Reset conversation history for this chat
   */
  bot.command("reset", async (ctx: Context) => {
    const userId = String(ctx.from?.id ?? "unknown");
    const chatId = String(ctx.chat?.id ?? "unknown");
    log.debug({ userId, chatId }, "Command: reset");
    orchestrator.resetConversation(userId, chatId);
    await ctx.reply("✅ *Conversation reset.* Ready when you are.", {
      parse_mode: "Markdown",
    });
  });

  /**
   * /new — Alias for /reset
   */
  bot.command("new", async (ctx: Context) => {
    const userId = String(ctx.from?.id ?? "unknown");
    const chatId = String(ctx.chat?.id ?? "unknown");
    log.debug({ userId, chatId }, "Command: new");
    orchestrator.resetConversation(userId, chatId);
    await ctx.reply("✨ *Fresh start.* New conversation — go ahead.", {
      parse_mode: "Markdown",
    });
  });

  /**
   * /model — Show current model
   */
  bot.command("model", async (ctx: Context) => {
    const { provider, model } = activeModel(getEnv());
    await ctx.reply(`🎯 *Model*\n\n${kv("Provider", provider)}\n${kv("Model", `\`${model}\``)}`, {
      parse_mode: "Markdown",
    });
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
      const effective = escapeMarkdown(custom ?? env.SYSTEM_PROMPT ?? defaultSystemPrompt());
      const source = custom ? "Custom (this chat)" : env.SYSTEM_PROMPT ? "Environment" : "Default";

      const lines = [
        kv("Source", source),
        kv("Chat", `\`${chatId}\``),
        "",
        effective,
        "",
        "—",
        "Use `/system set <prompt>` to change it, or `/system reset` to restore the default.",
      ];
      await sendLongMessage(ctx, `🧠 *System Prompt*\n\n${lines.join("\n")}`);
      return;
    }

    // Reserved sub-commands
    if (args === "reset" || args === "clear" || args === "default") {
      await systemPromptStore.clear(chatId);
      log.debug({ chatId }, "System prompt reset");
      await ctx.reply("♻️ *System prompt reset.* Back to the default persona.", {
        parse_mode: "Markdown",
      });
      return;
    }

    if (args === "help") {
      await ctx.reply(
        `🧠 *System Prompt*\n\n${commandList([
          ["/system", "view the current prompt"],
          ["/system set <prompt>", "set a custom prompt for this chat"],
          ["/system reset", "restore the default"],
        ])}\n\nCustom prompts are saved per chat and persist across restarts.`,
        { parse_mode: "Markdown" },
      );
      return;
    }

    // "set <prompt>" → strip the prefix
    const prompt = args.startsWith("set ") ? args.slice(4).trim() : args;

    if (!prompt) {
      await ctx.reply("⚠️ Please include a prompt — e.g. `/system set You are a pirate.`", {
        parse_mode: "Markdown",
      });
      return;
    }

    await systemPromptStore.set(chatId, prompt);
    log.debug({ chatId }, "System prompt updated");
    await sendLongMessage(
      ctx,
      `✅ *System prompt updated.*\n\n${escapeMarkdown(
        prompt,
      )}\n\nUse \`/system\` to view it, or \`/system reset\` to restore the default.`,
    );
  });
}

/**
 * Extract the arguments that follow a Telegram command.
 *
 * Handles both `/system set foo` and `/system@MyBot set foo`, returning
 * the raw remainder (e.g. `set foo`) or "" when there are no arguments.
 */
export function extractCommandArgs(ctx: Context): string {
  const text = ctx.message && "text" in ctx.message ? ctx.message.text : "";
  return text.replace(/^\s*\/\w+(?:@\w+)?\s*/, "").trim();
}

/** Resolve the active provider + model from the environment. */
function activeModel(env: EnvConfig): { provider: string; model: string } {
  const provider = env.LLM_PROVIDER ?? "anthropic";
  const model =
    provider === "openai"
      ? (env.OPENAI_MODEL ?? "gpt-4o")
      : (env.ANTHROPIC_MODEL ?? "claude-sonnet-4-20250514");
  return { provider, model };
}

function welcomeMessage(name: string): string {
  return `✦ *Hey ${name}, I'm Boop.*

Your AI agent on Telegram. I read links before answering, watch YouTube videos so you don't have to, and read files right here in chat.

*Try me now*
🔗 Paste any link + ask me about it
📄 Send a PDF with your question as the caption
🔍 Ask anything current — I search live

Tap ⌘ or \`/menu\` for the control panel.`;
}

function helpMessage(): string {
  return `✦ *Boop — Usage*

Send me a message and I'll respond. Everything else is one tap away in \`/menu\`.

*What I read*
• *Links* — any URL: articles, PDFs, docs, JSON
• *YouTube* — title, channel, full caption transcript
• *Files* — PDF / txt / md / code / JSON sent in chat
• *mailto:* links — I describe the draft they open

*What I do*
• *Chat & analyze* — research, writing, coding
• *Live web search* — current events and facts
• *Memory* — facts kept across chats
• *Approvals* — risky actions wait for your OK
• *Digest* — summarize recent Telegram chats (Bot-API or MTProto when configured)
• *Trading* — overnight CLS/OPG paper portfolio (DRY_RUN safe by default)

*Commands*
${commandList([
  ["/menu", "interactive control panel"],
  ["/new", "fresh conversation"],
  ["/system set <prompt>", "make me anyone"],
  ["/system reset", "default persona"],
  ["/model · /status", "config at a glance"],
  ["/digest [hours]", "summarize recent chats"],
  ["/chats · /chat <name|#> [hours]", "list / summarize one chat"],
  ["/ask <question> [hours]", "Q&A over recent chat history"],
  ["/join <invite link>", "join a chat (MTProto)"],
  ["/portfolio · /watchlist · /trading", "trading status & positions"],
  ["/run_now · /exit_now", "run overnight entries/exits now"],
])}`;
}
