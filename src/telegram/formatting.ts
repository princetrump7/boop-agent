import type { Context } from "telegraf";

/**
 * Telegram message length limit (characters).
 */
const TELEGRAM_MAX_LENGTH = 4096;

/**
 * Send a long message, splitting across multiple messages if needed.
 * Uses markdown formatting and gracefully handles messages that exceed
 * Telegram's character limit by splitting into paragraphs.
 */
export async function sendLongMessage(
  ctx: Context,
  text: string,
  options?: { parseMode?: "Markdown" | "HTML"; replyTo?: number },
): Promise<void> {
  const parseMode = options?.parseMode ?? "Markdown";
  const maxLen = TELEGRAM_MAX_LENGTH;

  if (text.length <= maxLen) {
    try {
      await ctx.reply(text, {
        parse_mode: parseMode,
        ...(options?.replyTo ? { reply_parameters: { message_id: options.replyTo } } : {}),
      });
    } catch {
      // Fallback: strip formatting and retry
      try {
        await ctx.reply(stripMarkdown(text), {
          ...(options?.replyTo ? { reply_parameters: { message_id: options.replyTo } } : {}),
        });
      } catch {
        // Silently drop messages that can't be sent
      }
    }
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
        try {
          await ctx.reply(currentChunk, {
            parse_mode: parseMode,
            ...(options?.replyTo ? { reply_parameters: { message_id: options.replyTo } } : {}),
          });
        } catch {
          try {
            await ctx.reply(stripMarkdown(currentChunk));
          } catch {
            // skip
          }
        }
      }

      // If the paragraph itself is too long, split by sentences
      if (para.length > maxLen) {
        const sentences = para.match(/[^.!?\n]+[.!?\n]*/g) ?? [para];
        let sentenceChunk = "";
        for (const sentence of sentences) {
          const candidateSentence = sentenceChunk ? `${sentenceChunk}${sentence}` : sentence;
          if (candidateSentence.length > maxLen) {
            if (sentenceChunk) {
              try {
                await ctx.reply(sentenceChunk.trim(), {
                  parse_mode: parseMode,
                });
              } catch {
                try { await ctx.reply(stripMarkdown(sentenceChunk.trim())); } catch { /* skip */ }
              }
            }
            sentenceChunk = sentence;
          } else {
            sentenceChunk = candidateSentence;
          }
        }
        if (sentenceChunk) {
          currentChunk = sentenceChunk.trim();
        } else {
          currentChunk = "";
        }
      } else {
        currentChunk = para;
      }
    } else {
      currentChunk = candidate;
    }
  }

  // Flush remaining
  if (currentChunk) {
    try {
      await ctx.reply(currentChunk, {
        parse_mode: parseMode,
        ...(options?.replyTo ? { reply_parameters: { message_id: options.replyTo } } : {}),
      });
    } catch {
      try {
        await ctx.reply(stripMarkdown(currentChunk));
      } catch {
        // skip
      }
    }
  }
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
