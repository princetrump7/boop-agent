import { Telegraf } from "telegraf";
import { getEnv } from "../config/env.js";
import type { Logger } from "../config/logger.js";
import { Orchestrator } from "../agent/orchestrator.js";
import { InteractionAgent } from "../agent/interaction-agent.js";
import { authMiddleware } from "./auth.js";
import { registerHandlers } from "./handlers.js";
import { registerCommands } from "./commands.js";
import { registerApprovalCallbacks } from "./approvals.js";

/**
 * Create and configure the Telegram bot.
 *
 * Merges the bot creation patterns from both original projects:
 * - boop-telegram's Telegraf-based setup with auth and commands
 * - telegram-agent's dual-mode (in-memory / Convex-backed)
 */
export interface BotInstance {
  bot: Telegraf;
  orchestrator: Orchestrator;
  interactionAgent: InteractionAgent | null;
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
    interactionAgent = new InteractionAgent(logger);
    log.info("Convex URL configured — interaction agent enabled");
  } else {
    log.info("No Convex URL — using in-memory orchestrator only");
  }

  // Apply auth middleware
  bot.use(authMiddleware(logger));

  // Register commands
  registerCommands(bot, orchestrator, logger);

  // Register approval callbacks
  registerApprovalCallbacks(bot, logger);

  // Register message handlers
  registerHandlers(bot, orchestrator, interactionAgent, logger);

  // Handle bot errors
  bot.catch((err, ctx) => {
    log.error({ err, ctx: ctx?.updateType }, "Bot error caught");
  });

  return {
    bot,
    orchestrator,
    interactionAgent,
    async start() {
      log.info("Starting bot with long-polling...");
      await bot.launch({
        allowedUpdates: ["message", "callback_query"],
      });
      log.info("Bot started successfully");

      // Log bot info
      try {
        const botInfo = await bot.telegram.getMe();
        log.info({ username: botInfo.username, id: botInfo.id }, "Bot info");
      } catch {
        log.warn("Could not fetch bot info");
      }
    },
    async stop() {
      log.info("Stopping bot...");
      bot.stop();
      log.info("Bot stopped");
    },
  };
}
