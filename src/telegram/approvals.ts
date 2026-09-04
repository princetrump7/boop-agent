import { Markup } from "telegraf";
import type { Context } from "telegraf";
import type { Logger } from "../config/logger.js";
import { escapeMarkdown } from "./formatting.js";

/**
 * Human-in-the-loop approval system for sensitive operations.
 *
 * When the agent wants to perform a sensitive action (e.g., write to disk,
 * execute a command, send data to an external API), it can create a
 * approval request. The user is shown a Yes/No inline keyboard and the
 * action only proceeds if approved.
 */

export interface ApprovalRequest {
  id: string;
  action: string;
  description: string;
  chatId: number;
  messageId?: number;
  resolved: boolean;
  approved: boolean;
}

const pendingApprovals = new Map<string, ApprovalRequest & { createdAt: number }>();

let approvalCounter = 0;
const APPROVAL_TTL_MS = 5 * 60 * 1000;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

function ensureSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, r] of pendingApprovals) {
      if (now - (r as { createdAt: number }).createdAt > APPROVAL_TTL_MS) pendingApprovals.delete(id);
    }
    if (pendingApprovals.size === 0 && sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }, 60_000);
  if (sweepTimer && typeof (sweepTimer as unknown as { unref?: () => void }).unref === "function") {
    (sweepTimer as unknown as { unref: () => void }).unref();
  }
}

/**
 * Create an approval request and send it to the chat.
 * Returns the approval request ID.
 */
export async function requestApproval(
  ctx: Context,
  action: string,
  description: string,
  logger: Logger,
): Promise<string> {
  approvalCounter++;
  const id = `approval_${approvalCounter}_${Date.now()}`;

  const request: ApprovalRequest & { createdAt: number } = {
    id,
    action,
    description,
    chatId: ctx.chat?.id ?? 0,
    resolved: false,
    approved: false,
    createdAt: Date.now(),
  };

  pendingApprovals.set(id, request as ApprovalRequest & { createdAt: number });
  ensureSweep();

  const keyboard = Markup.inlineKeyboard([
    Markup.button.callback("✅ Approve", `approve:${id}`),
    Markup.button.callback("❌ Deny", `deny:${id}`),
  ]);

  try {
    const msg = await ctx.reply(
      `🔐 *Approval Required*\n\n*Action* — ${escapeMarkdown(
        action,
      )}\n*Description* — ${escapeMarkdown(description)}\n\nApprove this action?`,
      {
        parse_mode: "Markdown",
        ...keyboard,
      },
    );
    request.messageId = msg.message_id;
  } catch (err) {
    logger.error({ err, action }, "Failed to send approval request");
    throw err;
  }

  logger.debug({ id, action }, "Approval request sent");
  return id;
}

/**
 * Check if an approval was granted.
 * Blocks until resolved or timeout.
 */
export async function waitForApproval(id: string, timeoutMs = 30000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const request = pendingApprovals.get(id);
    if (request?.resolved) {
      return request.approved;
    }
    await sleep(200);
  }
  // Timeout — deny
  pendingApprovals.delete(id);
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Handle approval callback queries (inline button clicks).
 */
export function registerApprovalCallbacks(
  bot: { action: (pattern: RegExp, handler: (ctx: Context) => Promise<void>) => void },
  logger: Logger,
): void {
  const log = logger.child({ component: "Approvals" });

  // "approve:{id}" or "deny:{id}"
  bot.action(/^(approve|deny):(.+)$/, async (ctx: Context) => {
    try {
      const match = (ctx as unknown as { match: RegExpExecArray | undefined }).match;
      if (!match) {
        await ctx.answerCbQuery("Invalid request.");
        return;
      }
      const action = match[1] as "approve" | "deny";
      const id = match[2];

      const request = pendingApprovals.get(id);
      if (!request) {
        await ctx.answerCbQuery("This request has expired or already been resolved.");
        return;
      }

      if (request.chatId !== ctx.chat?.id) {
        await ctx.answerCbQuery("You are not authorized to resolve this request.");
        return;
      }

      request.resolved = true;
      request.approved = action === "approve";

      const statusText = action === "approve" ? "✅ Approved" : "❌ Denied";
      await ctx.editMessageText(
        `🔐 *Approval Request*\n\n*Action* — ${escapeMarkdown(
          request.action,
        )}\n*Status* — ${statusText}`,
        { parse_mode: "Markdown" },
      );
      await ctx.answerCbQuery(statusText);

      log.debug({ id, action }, "Approval resolved");
    } catch (err) {
      log.error({ err }, "Error handling approval callback");
      await ctx.answerCbQuery("Error processing request.").catch(() => {});
    }
  });
}
