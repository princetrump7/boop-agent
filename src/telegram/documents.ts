import type { Context } from "telegraf";
import type { Logger } from "../config/logger.js";
import { sendLongMessage } from "./formatting.js";
import type { Orchestrator } from "../agent/orchestrator.js";
import type { InteractionAgent } from "../agent/interaction-agent.js";
import type { SystemPromptStore } from "../agent/system-prompt.js";
import { MAX_BYTES, extractFromBuffer } from "../tools/web-fetch.js";

/**
 * Handlers for files sent directly in chat ("local files" for a cloud bot).
 *
 * Documents (PDF, text, markdown, code, JSON…) are downloaded through the
 * Bot API, run through the same extraction pipeline as web_fetch, and the
 * extracted text is fed to the agent as part of the user's message.
 * Media without a text pipeline (photos, audio, video) gets an honest note.
 */

const DOWNLOAD_TIMEOUT_MS = 30_000;
/** Cap on how much extracted file text we inject into one agent message. */
const MAX_INJECTED_CHARS = 12_000;

interface DocumentMessage {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export function registerDocumentHandlers(
  bot: {
    on: (event: string | readonly string[], handler: (ctx: Context) => Promise<void>) => void;
  },
  orchestrator: Orchestrator,
  interactionAgent: InteractionAgent | null,
  systemPromptStore: SystemPromptStore,
  logger: Logger,
): void {
  const log = logger.child({ component: "Documents" });

  bot.on("document", async (ctx: Context) => {
    const msg = ctx.message;
    if (!msg || !("document" in msg)) return;
    const doc = msg.document as DocumentMessage;

    const caption = "caption" in msg && typeof msg.caption === "string" ? msg.caption : "";
    await ctx.sendChatAction("typing");

    try {
      const sizeKb = ((doc.file_size ?? 0) / 1024).toFixed(0);
      if ((doc.file_size ?? 0) > MAX_BYTES) {
        await ctx.reply(
          `That file is ${sizeKb} KB — I can only read files up to ${(MAX_BYTES / 1e6).toFixed(0)} MB.`,
        );
        return;
      }

      log.debug(
        { fileId: doc.file_id, name: doc.file_name, mime: doc.mime_type },
        "Downloading document",
      );
      const link = await ctx.telegram.getFileLink(doc.file_id);
      const res = await fetch(link.toString(), {
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (!res.ok) {
        await ctx.reply(
          `Telegram wouldn't let me download that file (HTTP ${res.status}). Try sending it again.`,
        );
        return;
      }
      const buffer = await res.arrayBuffer();
      if (buffer.byteLength > MAX_BYTES) {
        await ctx.reply(
          `That file is too large for me to read (${(buffer.byteLength / 1e6).toFixed(1)} MB).`,
        );
        return;
      }

      const extracted = await extractFromBuffer(buffer, {
        contentType: doc.mime_type,
        filename: doc.file_name,
      });

      const messageText = buildFileMessage(doc, extracted, caption);
      await processWithAgent(ctx, messageText, orchestrator, interactionAgent, systemPromptStore);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error({ err: errorMsg, file: doc.file_name }, "Error processing document");
      await safeReply(ctx, "💥 Something went wrong reading that file. Please try again.");
    }
  });

  // Media types with no text pipeline yet — reply honestly rather than ignore.
  bot.on(["photo", "video", "video_note", "audio", "voice", "sticker"], async (ctx: Context) => {
    log.debug({ updateType: ctx.updateType }, "Unsupported media type received");
    await safeReply(
      ctx,
      "I can't read images, audio or video yet. Send the content as text, a link, or a document " +
        "(PDF / txt / md / code / JSON) and I'll read it.",
    );
  });
}

/** Compose the synthetic user message carrying the extracted file contents. */
function buildFileMessage(
  doc: DocumentMessage,
  extracted: Awaited<ReturnType<typeof extractFromBuffer>>,
  caption: string,
): string {
  const kb = ((doc.file_size ?? 0) / 1024).toFixed(0);
  const parts: string[] = [`📎 File sent by the user: ${doc.file_name ?? "unnamed"} (${kb} KB)`];
  if (caption) parts.push("", `The user says about this file: "${caption}"`);
  parts.push("", `--- Extracted content (${extracted.kind}) ---`);

  if (extracted.note) parts.push(`Note: ${extracted.note}`);
  if (!extracted.body.trim()) {
    if (!extracted.note) parts.push("(No readable text could be extracted from this file.)");
    return parts.join("\n");
  }

  const body =
    extracted.body.length <= MAX_INJECTED_CHARS
      ? extracted.body
      : `${extracted.body.slice(0, MAX_INJECTED_CHARS)}\n\n[...file truncated at ${MAX_INJECTED_CHARS} of ${extracted.body.length} characters]`;
  parts.push(body);
  return parts.join("\n");
}

/** Same two-path dispatch as the text handler in handlers.ts. */
async function processWithAgent(
  ctx: Context,
  messageText: string,
  orchestrator: Orchestrator,
  interactionAgent: InteractionAgent | null,
  systemPromptStore: SystemPromptStore,
): Promise<void> {
  const userId = String(ctx.from?.id ?? "unknown");
  const chatId = String(ctx.chat?.id ?? "unknown");
  const customPrompt = await systemPromptStore.get(chatId);

  if (interactionAgent) {
    const history = orchestrator.getConversationHistory(chatId, userId).map((m) => ({ role: m.role, content: m.content }));
    const result = await interactionAgent.processMessage(
      chatId,
      userId,
      messageText,
      history,
      customPrompt ?? undefined,
    );
    orchestrator.appendHistory(chatId, userId, "user", messageText);
    orchestrator.appendHistory(chatId, userId, "assistant", result.response);
    await sendLongMessage(ctx, result.response);
  } else {
    const result = await orchestrator.processMessage(
      userId,
      chatId,
      messageText,
      customPrompt ?? undefined,
    );
    await sendLongMessage(ctx, result.response);
  }
}

async function safeReply(ctx: Context, text: string): Promise<void> {
  try {
    await ctx.reply(text);
  } catch {
    // Best effort
  }
}
