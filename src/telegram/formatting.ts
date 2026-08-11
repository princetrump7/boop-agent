import type { Context } from "telegraf";

/** Telegram message length limit (characters). */
const TELEGRAM_MAX_LENGTH = 4096;

type ParseMode = "Markdown" | "HTML";

export interface SendOptions {
  parseMode?: ParseMode;
  replyTo?: number;
}

/**
 * Send a message, splitting across multiple messages if it exceeds
 * Telegram's character limit.
 *
 * Falls back to plain text when the formatted message fails to send
 * (e.g. unbalanced markdown from third-party content).
 */
export async function sendLongMessage(
  ctx: Context,
  text: string,
  options: SendOptions = {},
): Promise<void> {
  const parseMode = options.parseMode ?? "Markdown";
  const maxLen = TELEGRAM_MAX_LENGTH;

  if (text.length <= maxLen) {
    await sendChunk(ctx, text, parseMode, options.replyTo);
    return;
  }

  // Split into chunks by paragraph boundaries
  const paragraphs = text.split("\n\n");
  let currentChunk = "";

  for (const para of paragraphs) {
    const candidate = currentChunk ? `${currentChunk}\n\n${para}` : para;

    if (candidate.length > maxLen) {
      // Flush current chunk
      if (currentChunk) {
        await sendChunk(ctx, currentChunk, parseMode, options.replyTo);
        currentChunk = "";
      }

      // If the paragraph itself is too long, split by sentences
      if (para.length > maxLen) {
        const sentences = para.match(/[^.!?\n]+[.!?\n]*/g) ?? [para];
        let sentenceChunk = "";
        for (const sentence of sentences) {
          const candidateSentence = sentenceChunk
            ? `${sentenceChunk}${sentence}`
            : sentence;
          if (candidateSentence.length > maxLen) {
            if (sentenceChunk) {
              await sendChunk(ctx, sentenceChunk.trim(), parseMode, options.replyTo);
            }
            sentenceChunk = sentence;
          } else {
            sentenceChunk = candidateSentence;
          }
        }
        currentChunk = sentenceChunk.trim();
      } else {
        currentChunk = para;
      }
    } else {
      currentChunk = candidate;
    }
  }

  // Flush remaining
  if (currentChunk) {
    await sendChunk(ctx, currentChunk, parseMode, options.replyTo);
  }
}

/**
 * Send a single chunk, falling back to plain text if parsing fails.
 */
async function sendChunk(
  ctx: Context,
  text: string,
  parseMode: ParseMode,
  replyTo?: number,
): Promise<void> {
  const replyParams = replyTo
    ? { reply_parameters: { message_id: replyTo } }
    : {};

  try {
    await ctx.reply(text, { parse_mode: parseMode, ...replyParams });
  } catch {
    try {
      await ctx.reply(stripMarkdown(text), replyParams);
    } catch {
      // Silently drop messages that can't be sent
    }
  }
}

/**
 * Escape Telegram legacy Markdown special characters so user-provided
 * content (prompts, names, etc.) renders literally instead of breaking
 * the message formatting.
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/([\\_*`[])/g, "\\$1");
}

/** Format a label/value line: `*Label* — value`. */
export function kv(label: string, value: string): string {
  return `*${label}* — ${value}`;
}

/** Format a list of commands as monospaced commands with descriptions. */
export function commandList(items: Array<[string, string]>): string {
  return items.map(([cmd, desc]) => `\`${cmd}\` — ${desc}`).join("\n");
}

/**
 * Strip markdown formatting from text (fallback when markdown parse fails).
 */
function stripMarkdown(text: string): string {
  return text
    .replace(/[*_~`#\[\]()>|]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
