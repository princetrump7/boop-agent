import type { Context } from "telegraf";
import type { Logger } from "../config/logger.js";
import { sendLongMessage } from "./formatting.js";
import type { Orchestrator } from "../agent/orchestrator.js";
import type { InteractionAgent } from "../agent/interaction-agent.js";
import type { SystemPromptStore } from "../agent/system-prompt.js";

/**
 * Register the main message handler that processes user messages
 * through the agent and returns responses.
 */
export function registerHandlers(
  bot: { on: (event: string, handler: (ctx: Context) => Promise<void>) => void },
  orchestrator: Orchestrator,
  interactionAgent: InteractionAgent | null,
  systemPromptStore: SystemPromptStore,
  logger: Logger,
): void {
  const log = logger.child({ component: "Handlers" });

  bot.on("text", async (ctx: Context) => {
    // Ignore commands (handled by command handlers)
    if (ctx.message && "text" in ctx.message && ctx.message.text.startsWith("/")) {
      return;
    }

    const userId = String(ctx.from?.id ?? "unknown");
    const chatId = String(ctx.chat?.id ?? "unknown");
    const messageText = ctx.message && "text" in ctx.message ? ctx.message.text : "";

    if (!messageText) {
      return;
    }

    log.debug({ userId, chatId, text: messageText.substring(0, 100) }, "Processing message");

    // Send typing indicator
    await ctx.sendChatAction("typing");

    try {
      // Resolve the per-chat custom system prompt (if any) so both agent
      // paths use the same persona overrides.
      const customPrompt = await systemPromptStore.get(chatId);

      if (interactionAgent) {
        // Convex-backed path — use orchestrator's in-memory history as fallback
        // until Convex messages table is fully wired (schema already exists).
        const history: Array<{ role: string; content: string; toolCallId?: string }> =
          orchestrator.getConversationHistory(chatId, userId).map((m) => ({ role: m.role, content: m.content }));
        const result = await interactionAgent.processMessage(
          chatId,
          userId,
          messageText,
          history,
          customPrompt ?? undefined,
        );
        // Mirror into orchestrator history so Bot-API digest fallback sees it even on Convex path
        orchestrator.appendHistory(chatId, userId, "user", messageText);
        orchestrator.appendHistory(chatId, userId, "assistant", result.response);

        // Send response
        await sendLongMessage(ctx, result.response);

        // Log usage if available
        if (result.estimatedCost !== undefined || result.totalTokens !== undefined) {
          log.info(
            {
              toolCalls: result.toolCalls,
              toolCycles: result.toolCycles,
              estimatedCost: result.estimatedCost,
              totalTokens: result.totalTokens,
            },
            "Message processed (Convex path)",
          );
        }
      } else {
        // In-memory path
        const result = await orchestrator.processMessage(
          userId,
          chatId,
          messageText,
          customPrompt ?? undefined,
        );

        // Send response
        await sendLongMessage(ctx, result.response);

        // Log usage
        log.info(
          {
            toolCalls: result.toolCalls,
            toolCycles: result.toolCycles,
            estimatedCost: result.estimatedCost,
            totalTokens: result.totalTokens,
          },
          "Message processed (in-memory path)",
        );
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error({ err: errorMsg }, "Error processing message");

      try {
        await ctx.reply("💥 *Something went wrong.* Please try again in a moment.", {
          parse_mode: "Markdown",
        });
      } catch {
        // Best effort
      }
    }
  });
}
