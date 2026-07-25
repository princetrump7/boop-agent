import type { Middleware } from "telegraf";
import type { Context } from "telegraf";
import { getEnv, isUserAuthorized, isChatAuthorized } from "../config/env.js";
import type { Logger } from "../config/logger.js";

/**
 * Auth middleware for Telegram bot.
 *
 * Combines both authorization patterns from the merged projects:
 * 1. Single-user mode via AUTHORIZED_USER_ID
 * 2. Multi-user mode via AUTHORIZED_USER_IDS (comma-separated)
 * 3. Optional chat-level authorization via AUTHORIZED_CHAT_IDS
 *
 * Unauthorized users receive a polite rejection and are ignored.
 */
export function authMiddleware(logger: Logger): Middleware<Context> {
  const log = logger.child({ component: "Auth" });

  return async (ctx: Context, next: () => Promise<void>) => {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;

    if (!userId) {
      log.warn("No user ID in message — skipping");
      return;
    }

    // Check chat-level authorization
    if (chatId && !isChatAuthorized(chatId)) {
      log.warn({ userId, chatId }, "Chat not authorized");
      return;
    }

    // Check user authorization
    if (!isUserAuthorized(userId)) {
      log.warn({ userId }, "User not authorized");
      const env = getEnv();
      if (env.UNAUTHORIZED_MESSAGE) {
        try {
          await ctx.reply(env.UNAUTHORIZED_MESSAGE);
        } catch {
          // best effort
        }
      }
      return;
    }

    // Authorized — continue
    log.debug({ userId, chatId }, "Authorized request");
    await next();
  };
}
