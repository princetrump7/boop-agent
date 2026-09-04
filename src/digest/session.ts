/**
 * MTProto transcript provider — optional GramJS sidecar + Bot-API fallback.
 *
 * - When TELEGRAM_API_ID / TELEGRAM_API_HASH / SESSION_B64 are configured,
 *   materialize a GramJS (telegram npm) user client and fetch full dialog
 *   history via iterMessages, matching telegram-summarizer's iter_dialogs
 *   + build_transcript behaviour.
 * - Otherwise, digest callers fall back to Bot-API transcripts supplied via
 *   collectBotApiTranscripts() which reads from Boop's stored Convex
 *   conversationHistory / recent messages map passed in by the caller.
 *
 * GramJS is an optional peer dependency; the module loads it lazily and
 * surfaces a clear error if the env says MTProto but the package is absent.
 */
import { getEnv, hasMtprotoConfig } from "../config/env.js";
import type { Logger } from "../config/logger.js";
import { buildTranscript, type DigestMessage } from "./transcript.js";
import type { ChatTranscript } from "./pipeline.js";

// ---------------------------------------------------------------------------
// Bot-API transcript collector (no MTProto, uses Boop's own history)
// ---------------------------------------------------------------------------

export interface BotApiChatHistory {
  chatId: string | number;
  title: string;
  username?: string;
  messages: Array<{ role: string; content: string; createdAt?: string | number | Date }>;
}

export function collectBotApiTranscripts(
  histories: BotApiChatHistory[],
  opts: { sinceUtc: Date; hourWindow: number; maxMessages: number },
  logger?: Logger,
): ChatTranscript[] {
  const out: ChatTranscript[] = [];
  for (const h of histories) {
    const msgs: DigestMessage[] = h.messages
      .slice(-opts.maxMessages)
      .map((m) => ({
        date: m.createdAt ? new Date(m.createdAt) : new Date(),
        senderName: m.role === "assistant" ? "Boop" : "User",
        text: m.content ?? "",
      }))
      .filter((m) => m.date >= opts.sinceUtc);

    if (msgs.length === 0) {
      logger?.debug({ chatId: h.chatId }, "Bot-API transcript: no messages in window");
      continue;
    }

    const built = buildTranscript(msgs, { title: h.title, chatId: h.chatId, username: h.username }, opts.sinceUtc);
    out.push({ title: built.title, chatId: built.chatId, chunks: built.chunks, messageCount: built.messageCount });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers for optional MTProto path
// ---------------------------------------------------------------------------

function tryRequireGramJs(): any | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("telegram") as any;
  } catch {
    return null;
  }
}

/**
 * Materialize SESSION_B64 to a session string for GramJS StringSession.
 * Returns null if not configured — caller should fall back to Bot-API mode.
 */
export function getMtprotoSessionString(): string | null {
  const env = getEnv();
  if (!env.SESSION_B64) return null;
  try {
    const raw = Buffer.from(env.SESSION_B64, "base64").toString("utf-8");
    return raw.trim() || null;
  } catch {
    return env.SESSION_B64;
  }
}

export interface MtprotoFetchOptions {
  sinceUtc: Date;
  hourWindow: number;
  maxMessages: number;
  maxChats: number;
  findEntity?: string;
  logger?: Logger;
}

/**
 * Fetch transcripts via GramJS MTProto user client.
 * Lazy-loads `telegram` and `telegram/sessions` only when needed.
 * Returns null if MTProto is not configured or package missing.
 */
export async function fetchMtprotoTranscripts(
  opts: MtprotoFetchOptions,
): Promise<ChatTranscript[] | null> {
  if (!hasMtprotoConfig()) return null;

  const env = getEnv();
  const gram = tryRequireGramJs();
  if (!gram) {
    opts.logger?.warn(
      "MTProto requested (TELEGRAM_API_ID set) but 'telegram' package not installed — run `npm i telegram` and retry, falling back to Bot-API mode.",
    );
    return null;
  }

  // Lazy import StringSession if available
  let StringSession: new (s: string) => unknown;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    StringSession = require("telegram/sessions").StringSession as new (s: string) => unknown;
  } catch {
    opts.logger?.warn("Could not load telegram/sessions — MTProto digest unavailable.");
    return null;
  }

  const sessionStr = getMtprotoSessionString() ?? "";
  const session = new StringSession(sessionStr);
  const client = new gram.TelegramClient(
    session,
    Number(env.TELEGRAM_API_ID),
    String(env.TELEGRAM_API_HASH),
    { connectionRetries: 3 },
  );

  try {
    await (client as unknown as { connect: () => Promise<void> }).connect();
    if (env.TELEGRAM_PHONE) {
      // Start is interactive; for SESSION_B64 restores we just connect.
      // If not authorized, skip.
      try {
        const authorized = await (client as unknown as { isUserAuthorized: () => Promise<boolean> }).isUserAuthorized?.();
        if (!authorized) {
          opts.logger?.warn("MTProto session not authorized — fill SESSION_B64 via Telethon/GramJS login; falling back to Bot-API.");
          await (client as unknown as { disconnect: () => Promise<void> }).disconnect?.();
          return null;
        }
      } catch {
        // Best-effort check
      }
    }

    // Discover dialogs
    const dialogs = await (client as unknown as { getDialogs: (o?: unknown) => Promise<unknown[]> }).getDialogs({});
    const chats: Array<{ id: unknown; title: string; username?: string; entity: unknown }> = [];
    for (const d of dialogs as Array<Record<string, unknown>>) {
      const entity = (d as { entity?: Record<string, unknown> })?.entity;
      if (!entity) continue;
      // Skip private users if desired (match Python skip is_user), keep groups/channels
      // For now include all — caller caps by maxChats
      const title = (entity as { title?: string })?.title
        ?? (entity as { firstName?: string })?.firstName
        ?? String((d as { id?: unknown })?.id ?? "unknown");
      chats.push({ id: (d as { id?: unknown })?.id, title, username: (entity as { username?: string })?.username, entity });
      if (chats.length >= opts.maxChats) break;
    }

    // Filter by findEntity if requested (exact then substring, like fetch.py)
    let filtered = chats;
    if (opts.findEntity) {
      const q = opts.findEntity.toLowerCase();
      const exact = chats.filter((c) => c.title.toLowerCase() === q || `-${c.title.toLowerCase()}` === q);
      filtered = exact.length > 0 ? exact : chats.filter((c) => c.title.toLowerCase().includes(q));
    }

    const transcripts: ChatTranscript[] = [];
    for (const chat of filtered) {
      try {
        const messages = await (client as unknown as {
          getMessages: (entity: unknown, opts: unknown) => Promise<Record<string, unknown>[]>;
        }).getMessages(chat.entity, { limit: opts.maxMessages, reverse: false });

        const digestMsgs: DigestMessage[] = [];
        for (const m of messages as Array<Record<string, unknown>>) {
          const dateVal = (m as { date?: Date | number })?.date;
          const date = dateVal instanceof Date ? dateVal : dateVal ? new Date((dateVal as number) * 1000) : new Date();
          if (date < opts.sinceUtc) continue;
          const senderName =
            ((m as { sender?: { firstName?: string } })?.sender?.firstName as string | undefined)
            ?? (m as { fromId?: unknown })?.fromId ? "User" : "Unknown";
          const text = (m as { message?: string })?.message ?? (m as { text?: string })?.text ?? "";
          digestMsgs.push({ date, senderName, text });
        }
        if (digestMsgs.length === 0) continue;
        digestMsgs.sort((a, b) => a.date.getTime() - b.date.getTime());
        const built = buildTranscript(digestMsgs, { title: chat.title, chatId: String(chat.id ?? chat.title), username: chat.username }, opts.sinceUtc);
        transcripts.push({ title: built.title, chatId: built.chatId, chunks: built.chunks, messageCount: built.messageCount });
      } catch (err) {
        // FloodWait: respect retry-after if provided
        const e = err as { seconds?: number; errorMessage?: string };
        if (typeof e?.seconds === "number") {
          const wait = Math.min(e.seconds + 1, 120) * 1000;
          opts.logger?.warn({ chat: chat.title, seconds: e.seconds }, "FloodWait — sleeping");
          await new Promise((r) => setTimeout(r, wait));
        } else {
          opts.logger?.warn({ chat: chat.title, err }, "MTProto getMessages failed, skipping chat");
        }
      }
    }

    try {
      await (client as unknown as { disconnect: () => Promise<void> }).disconnect?.();
    } catch {
      // ignore
    }

    return transcripts;
  } catch (err) {
    opts.logger?.warn({ err }, "MTProto fetch failed — falling back to Bot-API transcript mode");
    try {
      await (client as unknown as { disconnect: () => Promise<void> }).disconnect?.();
    } catch { /* ignore */ }
    return null;
  }
}

/**
 * Best-effort chat listing for /chats (MTProto if available, else caller must
 * supply Bot-API chat list).
 */
export async function listChatsForPicker(
  logger?: Logger,
): Promise<Array<{ id: string; title: string; username?: string }>> {
  if (!hasMtprotoConfig()) return [];
  const env = getEnv();
  const gram = tryRequireGramJs();
  if (!gram) return [];
  let StringSession: new (s: string) => unknown;
  try {
    // eslint-disable-next -line @typescript-eslint/no-require-imports
    StringSession = require("telegram/sessions").StringSession as new (s: string) => unknown;
  } catch {
    return [];
  }
  const sessionStr = getMtprotoSessionString() ?? "";
  const session = new StringSession(sessionStr);
  const client = new gram.TelegramClient(
    session,
    Number(env.TELEGRAM_API_ID),
    String(env.TELEGRAM_API_HASH),
    { connectionRetries: 2 },
  );
  try {
    await (client as unknown as { connect: () => Promise<void> }).connect();
    const dialogs = await (client as unknown as { getDialogs: () => Promise<unknown[]> }).getDialogs();
    const out: Array<{ id: string; title: string; username?: string }> = [];
    for (const d of dialogs as Array<Record<string, unknown>>) {
      const entity = (d as { entity?: Record<string, unknown> })?.entity;
      if (!entity) continue;
      const title = (entity as { title?: string })?.title ?? (entity as { firstName?: string })?.firstName ?? String((d as { id?: unknown })?.id);
      out.push({ id: String((d as { id?: unknown })?.id ?? title), title, username: (entity as { username?: string })?.username });
      if (out.length >= (env.MAX_CHATS ?? 25)) break;
    }
    try { await (client as unknown as { disconnect: () => Promise<void> }).disconnect?.(); } catch { /* ignore */ }
    return out;
  } catch (err) {
    logger?.warn({ err }, "MTProto listChatsForPicker failed");
    try { await (client as unknown as { disconnect: () => Promise<void> }).disconnect?.(); } catch { /* ignore */ }
    return [];
  }
}
