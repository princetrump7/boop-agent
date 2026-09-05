import { Telegraf } from "telegraf";
import { getEnv, hasMtprotoConfig, hasTradingConfig } from "../config/env.js";
import type { Logger } from "../config/logger.js";
import { Orchestrator } from "../agent/orchestrator.js";
import { InteractionAgent } from "../agent/interaction-agent.js";
import { createSystemPromptStore } from "../agent/system-prompt.js";
import { authMiddleware } from "./auth.js";
import { registerHandlers } from "./handlers.js";
import { registerDocumentHandlers } from "./documents.js";
import { registerCommands } from "./commands.js";
import { registerMenu } from "./menu.js";
import { registerApprovalCallbacks } from "./approvals.js";
import { registerDigestCommands } from "../digest/handlers.js";
import { registerTradingCommands } from "../trading/commands.js";
import { createScheduler, type SchedulerHandle } from "../scheduler/index.js";
import { createLLMProviderFromEnv } from "../agent/providers/factory.js";
import { summarizeTranscripts, globalBriefing } from "../digest/pipeline.js";
import { collectBotApiTranscripts, fetchMtprotoTranscripts } from "../digest/session.js";
import { OvernightTradingService } from "../trading/service.js";
import { sendLongMessage } from "./formatting.js";

/**
 * Create and configure the Telegram bot.
 *
 * Merges the bot creation patterns from both original projects:
 * - boop-telegram's Telegraf-based setup with auth and commands
 * - telegram-agent's dual-mode (in-memory / Convex-backed)
 * - telegram-summarizer digest + overnight stock scheduling
 */
export interface BotInstance {
  bot: Telegraf;
  orchestrator: Orchestrator;
  interactionAgent: InteractionAgent | null;
  scheduler: SchedulerHandle | null;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

export function createBot(logger: Logger): BotInstance {
  const log = logger.child({ component: "Bot" });
  const env = getEnv();

  // Create Telegraf bot instance
  const bot = new Telegraf(env.TELEGRAM_BOT_TOKEN);

  // Create orchestrator (always available for in-memory path)
  const orchestrator = new Orchestrator(logger);

  // Create interaction agent if Convex is configured
  let interactionAgent: InteractionAgent | null = null;
  if (env.CONVEX_URL) {
    // Provide Bot-API fallback histories from orchestrator until Convex messages are wired
    interactionAgent = new InteractionAgent(logger, () => orchestrator.buildBotApiHistories());
    log.info("Convex URL configured — interaction agent enabled (with orchestrator history fallback)");
  } else {
    log.info("No Convex URL — using in-memory orchestrator only");
  }

  // Per-chat system prompt store (Convex-backed when available)
  const systemPromptStore = createSystemPromptStore(logger);
  log.info({ backend: systemPromptStore.backend }, "System prompt store initialized");

  // Apply auth middleware
  bot.use(authMiddleware(logger));

  // Singleton trading service — always created so /portfolio etc. answer even in
  // DRY_RUN demo without Alpaca keys (broker fakes account/prices in that mode).
  // Previously this was conditional on hasTradingConfig(), so trading commands fell
  // back to a second service instance and could look "not responding" (empty keys
  // caused 401 + empty replies). One singleton + advisory file lock = no races.
  const tradingService = new OvernightTradingService(log);
  log.info(
    {
      mode: tradingService.brokerInstance.modeLabel,
      hasKeys: hasTradingConfig(),
      symbols: getEnv().SYMBOLS,
    },
    "Trading service initialized (singleton)",
  );

  // Register commands
  registerCommands(bot, orchestrator, systemPromptStore, logger);
  registerMenu(bot, orchestrator, systemPromptStore, logger);
  // Digest + trading direct commands (bypass LLM loop)
  registerDigestCommands(bot as unknown as Parameters<typeof registerDigestCommands>[0], orchestrator, logger);
  registerTradingCommands(bot as unknown as Parameters<typeof registerTradingCommands>[0], logger, tradingService);

  // Register approval callbacks
  registerApprovalCallbacks(bot, logger);

  // Register message handlers
  registerHandlers(bot, orchestrator, interactionAgent, systemPromptStore, logger);
  registerDocumentHandlers(bot, orchestrator, interactionAgent, systemPromptStore, logger);

  // Handle bot errors
  bot.catch((err, ctx) => {
    log.error({ err, ctx: ctx?.updateType }, "Bot error caught");
  });

  // ── Scheduler (auto-digest + overnight trading) ────────────────────────
  const scheduler: SchedulerHandle = createScheduler(logger, {
    onAutoDigest: async () => {
      const e = getEnv();
      const hours = e.DEFAULT_HOURS ?? 24;
      const sinceUtc = new Date(Date.now() - hours * 60 * 60 * 1000);
      const maxMessages = e.MAX_MESSAGES ?? 800;
      const maxChats = e.MAX_CHATS ?? 25;
      const schLog = log.child({ component: "AutoDigest" });
      schLog.info({ hours, sinceUtc: sinceUtc.toISOString() }, "Running auto-digest");

      let transcripts: Awaited<ReturnType<typeof fetchMtprotoTranscripts>> | null = null;
      let chatTranscripts: import("../digest/pipeline.js").ChatTranscript[] = [];

      if (hasMtprotoConfig()) {
        try {
          transcripts = await fetchMtprotoTranscripts({
            sinceUtc,
            hourWindow: hours,
            maxMessages,
            maxChats,
            logger: schLog,
          });
          if (transcripts && transcripts.length > 0) chatTranscripts = transcripts;
        } catch (err) {
          schLog.warn({ err }, "MTProto auto-digest fetch failed, falling back to Bot-API");
        }
      }
      if (chatTranscripts.length === 0) {
        // Bot-API fallback from in-memory histories
        try {
          const histories = orchestrator.buildBotApiHistories();
          chatTranscripts = collectBotApiTranscripts(
            histories,
            { sinceUtc, hourWindow: hours, maxMessages },
            schLog,
          );
        } catch (err) {
          schLog.warn({ err }, "Bot-API transcript collect failed");
        }
      }
      if (chatTranscripts.length === 0) {
        schLog.info("Auto-digest: no transcripts in window — skipping");
        return;
      }
      try {
        const provider = createLLMProviderFromEnv(schLog);
        const perChat = await summarizeTranscripts(provider, chatTranscripts, { maxPoints: 7 }, schLog);
        const global = await globalBriefing(provider, perChat, schLog);
        const lines: string[] = [];
        lines.push(`# Auto Digest — last ${hours}h (${chatTranscripts.length} chats)`);
        lines.push("");
        lines.push(global);
        lines.push("");
        lines.push("---");
        for (const p of perChat) {
          lines.push(`## ${p.title}`);
          lines.push(p.summary);
          lines.push("");
        }
        const text = lines.join("\n");
        // Broadcast to authorized chats, or log if none configured
        const targets = e.AUTHORIZED_CHAT_IDS.length > 0 ? e.AUTHORIZED_CHAT_IDS : [];
        // Also include authorized users as fallback 1:1 chats if no chat IDs pinned
        if (targets.length === 0) {
          schLog.info("Auto-digest ready but no AUTHORIZED_CHAT_IDS set — logging instead of sending");
          // Still log first 800 chars so operator sees it
          schLog.info({ digestPreview: text.slice(0, 800) }, "Auto-digest (no broadcast targets)");
          return;
        }
        for (const chatId of targets) {
          try {
            const ctxLike = { reply: (t: string) => (bot.telegram as unknown as { sendMessage: (id:number,t:string, o?: unknown)=>Promise<void>}).sendMessage(chatId, t, { parse_mode: "Markdown" }) } as unknown as Parameters<typeof sendLongMessage>[0];
            await sendLongMessage(ctxLike, text);
          } catch (err) {
            schLog.warn({ err, chatId }, "Auto-digest send failed for chat");
            try {
              await (bot.telegram as unknown as { sendMessage: (id:number,t:string)=>Promise<void>}).sendMessage(chatId, text.slice(0, 4000));
            } catch { /* ignore */ }
          }
        }
      } catch (err) {
        schLog.error({ err }, "Auto-digest pipeline failed");
      }
    },
    onEntries: async () => {
      if (!hasTradingConfig() || !tradingService) {
        log.warn("Scheduler onEntries triggered but Alpaca not configured — skipping");
        return;
      }
      const svc = tradingService;
      const notify = async (t: string) => {
        const e = getEnv();
        const targets = e.AUTHORIZED_CHAT_IDS.length > 0 ? e.AUTHORIZED_CHAT_IDS : [];
        for (const chatId of targets) {
          try {
            await (bot.telegram as unknown as { sendMessage: (id:number,t:string)=>Promise<void>}).sendMessage(chatId, `🔔 Overnight entry: ${t}`);
          } catch { /* ignore */ }
        }
        log.info({ msg: t }, "Overnight entry notify");
      };
      try {
        const result = await svc.runEntries(notify);
        log.info({ submitted: result.submitted, skipped: result.skipped, failed: result.failed }, "Overnight entries complete");
        if (result.details.length > 0) {
          const summary = `Entries — submitted=${result.submitted} skipped=${result.skipped} failed=${result.failed}\n` + result.details.map((d) => `  ${d.symbol} ${d.action} ${d.qty ? `qty=${d.qty} ` : ""}— ${d.reason}`).join("\n");
          await notify(summary).catch(() => {});
        }
      } catch (err) {
        log.error({ err }, "Overnight entries failed");
      }
    },
    onExits: async () => {
      if (!hasTradingConfig() || !tradingService) {
        log.warn("Scheduler onExits triggered but Alpaca not configured — skipping");
        return;
      }
      const svc = tradingService;
      const notify = async (t: string) => {
        const e = getEnv();
        const targets = e.AUTHORIZED_CHAT_IDS.length > 0 ? e.AUTHORIZED_CHAT_IDS : [];
        for (const chatId of targets) {
          try {
            await (bot.telegram as unknown as { sendMessage: (id:number,t:string)=>Promise<void>}).sendMessage(chatId, `🔔 Overnight exit: ${t}`);
          } catch { /* ignore */ }
        }
        log.info({ msg: t }, "Overnight exit notify");
      };
      try {
        const result = await svc.runExits(notify);
        log.info({ submitted: result.submitted, skipped: result.skipped, failed: result.failed }, "Overnight exits complete");
        if (result.details.length > 0) {
          const summary = `Exits — submitted=${result.submitted} skipped=${result.skipped} failed=${result.failed}\n` + result.details.map((d) => `  ${d.symbol} ${d.action} ${d.qty ? `qty=${d.qty} ` : ""}— ${d.reason}`).join("\n");
          await notify(summary).catch(() => {});
        }
      } catch (err) {
        log.error({ err }, "Overnight exits failed");
      }
    },
  });

  return {
    bot,
    orchestrator,
    interactionAgent,
    scheduler,
    async start() {
      log.info("Starting bot with long-polling...");
      await bot.launch({
        allowedUpdates: ["message", "callback_query"],
      });
      log.info("Bot started successfully");

      // Keep Telegram's Menu button in sync with the registered commands.
      try {
        await bot.telegram.setMyCommands([
          { command: "menu", description: "Open the control panel" },
          { command: "new", description: "Start a fresh conversation" },
          { command: "system", description: "View or customize my persona" },
          { command: "model", description: "Show the active AI model" },
          { command: "status", description: "Show agent configuration" },
          { command: "help", description: "What I can read and do" },
          { command: "digest", description: "Summarize recent chats" },
          { command: "chats", description: "List available chats" },
          { command: "chat", description: "Summarize one chat" },
          { command: "ask", description: "Ask about recent chats" },
          { command: "join", description: "Join a chat by invite link (MTProto)" },
          { command: "portfolio", description: "Show open positions" },
          { command: "watchlist", description: "Trading watchlist & status" },
          { command: "trading", description: "Full trading status" },
          { command: "status_trading", description: "Trading status (alt)" },
          { command: "run_now", description: "Run entries now" },
          { command: "exit_now", description: "Run exits now" },
        ]);
        // Pin the left-of-input Menu button to always open this command
        // list (some clients otherwise keep a stale default per chat).
        await bot.telegram.setChatMenuButton({
          menuButton: { type: "commands" },
        });
        log.debug("Telegram command menu updated");
      } catch (err) {
        log.warn({ err }, "Could not set Telegram command menu");
      }

      // Log bot info
      try {
        const botInfo = await bot.telegram.getMe();
        log.info({ username: botInfo.username, id: botInfo.id }, "Bot info");
      } catch {
        log.warn("Could not fetch bot info");
      }

      // Start scheduler (auto-digest + overnight) — no-op if no env set
      try {
        scheduler.start();
        log.info("Scheduler started");
      } catch (err) {
        log.warn({ err }, "Scheduler failed to start");
      }
    },
    async stop() {
      log.info("Stopping bot...");
      try { scheduler.stop(); } catch { /* ignore */ }
      bot.stop();
      log.info("Bot stopped");
    },
  };
}
