import type { Context } from "telegraf";
import type { Logger } from "../config/logger.js";
import { sendLongMessage } from "../telegram/formatting.js";
import { splitForTelegram } from "./transcript.js";
import { getEnv, hasMtprotoConfig } from "../config/env.js";
import { createLLMProviderFromEnv } from "../agent/providers/factory.js";
import {
  summarizeTranscripts,
  globalBriefing,
  answerQuestion,
} from "./pipeline.js";
import {
  collectBotApiTranscripts,
  fetchMtprotoTranscripts,
  listChatsForPicker,
  type BotApiChatHistory,
} from "./session.js";
import type { Orchestrator } from "../agent/orchestrator.js";

export type HistoryProvider = () => BotApiChatHistory[] | Promise<BotApiChatHistory[]>;

function parseHours(raw: string | undefined): number {
  const env = getEnv();
  const fallback = env.DEFAULT_HOURS ?? 24;
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, 168);
}

function parseHoursAndFilter(args: string): { hours: number; filter?: string } {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  let hours: number | undefined;
  let filterParts: string[] = [];
  // Heuristic: last token numeric => hours; first token filter if two tokens and first non-numeric second numeric
  // Simpler: if last token is number, treat as hours and rest as filter
  if (parts.length > 0) {
    const last = parts[parts.length - 1]!;
    const n = Number(last);
    if (Number.isFinite(n) && n > 0) {
      hours = Math.min(n, 168);
      filterParts = parts.slice(0, -1);
    } else {
      filterParts = parts;
    }
  }
  return { hours: parseHours(hours !== undefined ? String(hours) : undefined), filter: filterParts.join(" ") || undefined };
}

async function resolveTranscripts(
  hours: number,
  findEntity: string | undefined,
  historyProvider: HistoryProvider | undefined,
  logger: Logger,
): Promise<import("./pipeline.js").ChatTranscript[]> {
  const env = getEnv();
  const sinceUtc = new Date(Date.now() - hours * 60 * 60 * 1000);
  const maxMessages = env.MAX_MESSAGES ?? 800;
  const maxChats = env.MAX_CHATS ?? 25;

  if (hasMtprotoConfig()) {
    const mt = await fetchMtprotoTranscripts({
      sinceUtc,
      hourWindow: hours,
      maxMessages,
      maxChats,
      findEntity,
      logger,
    });
    if (mt && mt.length > 0) return mt;
  }
  if (!historyProvider) return [];
  const histories = await historyProvider();
  return collectBotApiTranscripts(histories, { sinceUtc, hourWindow: hours, maxMessages }, logger);
}

function buildHistoryProviderFromOrchestrator(orchestrator: Orchestrator): HistoryProvider {
  // Mirrors Orchestrator.buildBotApiHistories but via public API (get snapshot)
  // Use any to access private map if needed — fallback to empty
  return () => {
    try {
      const anyO = orchestrator as unknown as { conversationHistory: Map<string, Array<{ role: string; content: string }>> };
      const out: BotApiChatHistory[] = [];
      for (const [convId, msgs] of (anyO.conversationHistory ?? new Map()).entries()) {
        const [chatId] = convId.split(":");
        out.push({
          chatId: chatId ?? convId,
          title: `chat ${chatId}`,
          messages: msgs.map((m) => ({ role: m.role, content: m.content })),
        });
      }
      return out;
    } catch {
      return [];
    }
  };
}

/**
 * Register direct digest commands: /digest, /chats, /chat, /join, /ask
 * These bypass the LLM loop and run the digest pipeline directly for
 * low-latency summaries (matching telegram-summarizer UX).
 */
export function registerDigestCommands(
  bot: {
    command: (name: string, handler: (ctx: Context) => Promise<void>) => void;
    on: (event: string, handler: (ctx: Context) => Promise<void>) => void;
  },
  orchestrator: Orchestrator,
  logger: Logger,
): void {
  const log = logger.child({ component: "DigestCommands" });
  const historyProvider = buildHistoryProviderFromOrchestrator(orchestrator);

  const extractArgs = (ctx: Context): string => {
    const text = ctx.message && "text" in ctx.message ? (ctx.message as { text: string }).text : "";
    return text.replace(/^\s*\/\w+(?:@\w+)?\s*/, "").trim();
  };

  bot.command("digest", async (ctx: Context) => {
    const raw = extractArgs(ctx);
    const { hours, filter } = parseHoursAndFilter(raw);
    await ctx.sendChatAction("typing").catch(() => {});
    const provider = createLLMProviderFromEnv(log);
    const transcripts = await resolveTranscripts(hours, filter, historyProvider, log);
    if (transcripts.length === 0) {
      await ctx.reply(
        `No chat history in the last ${hours}h${filter ? ` matching "${filter}"` : ""}. ` +
          `Bot-API mode only sees chats the bot has participated in; configure TELEGRAM_API_ID/TELEGRAM_API_HASH/SESSION_B64 for full dialog access.`,
      );
      return;
    }
    const filtered = filter
      ? transcripts.filter((t) => t.title.toLowerCase().includes(filter.toLowerCase()))
      : transcripts;
    if (filtered.length === 0) {
      await ctx.reply(`No chats matching "${filter}" in the last ${hours}h. Available: ${transcripts.map((t) => t.title).join(", ")}`);
      return;
    }
    try {
      const perChat = await summarizeTranscripts(provider, filtered, { maxPoints: 7 }, log);
      const global = await globalBriefing(provider, perChat, log);
      const lines: string[] = [];
      lines.push(`# Digest — last ${hours}h (${filtered.length} chats)`);
      lines.push("");
      lines.push(global);
      lines.push("");
      lines.push("---");
      lines.push("");
      for (const p of perChat) {
        lines.push(`## ${p.title}`);
        lines.push(p.summary);
        lines.push("");
      }
      await sendLongMessage(ctx as unknown as Parameters<typeof sendLongMessage>[0], lines.join("\n"));
    } catch (err) {
      log.error({ err }, "digest failed");
      await ctx.reply("Digest failed — check logs.").catch(() => {});
    }
  });

  bot.command("chats", async (ctx: Context) => {
    const chats = await listChatsForPicker(log);
    if (chats.length === 0) {
      await ctx.reply("No dialogs available. In MTProto mode, dialogs come from your Telegram account; in Bot-API mode, chats appear after the bot sees messages.");
      return;
    }
    const lines = chats.map((c, i) => `${i + 1}. ${c.title} — id=${c.id}${c.username ? ` @${c.username}` : ""}`);
    const text = `Chats (showing ${chats.length}):\n${lines.join("\n")}\n\nUse /chat <name|#> [hours] to summarize one.`;
    for (const chunk of splitForTelegram(text, 3900)) {
      await ctx.reply(chunk).catch(() => {});
    }
  });

  bot.command("chat", async (ctx: Context) => {
    const raw = extractArgs(ctx);
    if (!raw) {
      await ctx.reply("Usage: /chat <name|#> [hours]  — e.g. /chat family 24");
      return;
    }
    const parts = raw.split(/\s+/);
    // Try: /chat <filter> <hours>  OR /chat <#>
    let filter: string | undefined;
    let hours: number;
    if (parts.length === 1) {
      // could be numeric index
      const n = Number(parts[0]);
      if (Number.isFinite(n) && Number.isInteger(n) && n >= 1) {
        const chats = await listChatsForPicker(log);
        const picked = chats[n - 1];
        if (picked) filter = picked.title;
        else filter = parts[0];
        hours = parseHours(undefined);
      } else {
        filter = parts[0];
        hours = parseHours(undefined);
      }
    } else {
      const last = parts[parts.length - 1]!;
      const n = Number(last);
      if (Number.isFinite(n) && n > 0) {
        hours = parseHours(String(n));
        filter = parts.slice(0, -1).join(" ");
      } else {
        hours = parseHours(undefined);
        filter = raw;
      }
    }
    await ctx.sendChatAction("typing").catch(() => {});
    const provider = createLLMProviderFromEnv(log);
    const transcripts = await resolveTranscripts(hours, filter, historyProvider, log);
    if (transcripts.length === 0) {
      await ctx.reply(`No chat history for "${filter}" in the last ${hours}h.`);
      return;
    }
    const filtered = transcripts.filter((t) => t.title.toLowerCase().includes((filter ?? "").toLowerCase()));
    const target = filtered.length > 0 ? filtered : transcripts.slice(0, 1);
    try {
      const perChat = await summarizeTranscripts(provider, target, { maxPoints: 14 }, log);
      for (const p of perChat) {
        await sendLongMessage(ctx as unknown as Parameters<typeof sendLongMessage>[0], `## ${p.title}\n${p.summary}`);
      }
    } catch (err) {
      log.error({ err }, "chat failed");
      await ctx.reply("Chat summary failed.").catch(() => {});
    }
  });

  bot.command("ask", async (ctx: Context) => {
    const raw = extractArgs(ctx);
    if (!raw) {
      await ctx.reply("Usage: /ask <question> [hours]  — e.g. /ask what was decided about X? 48");
      return;
    }
    let question = raw;
    let hours = parseHours(undefined);
    const lastSpace = raw.lastIndexOf(" ");
    if (lastSpace !== -1) {
      const tail = raw.slice(lastSpace + 1);
      const n = Number(tail);
      if (Number.isFinite(n) && n > 0) {
        hours = parseHours(String(n));
        question = raw.slice(0, lastSpace).trim();
      }
    }
    if (!question) {
      await ctx.reply("Please provide a question.");
      return;
    }
    await ctx.sendChatAction("typing").catch(() => {});
    const provider = createLLMProviderFromEnv(log);
    const transcripts = await resolveTranscripts(hours, undefined, historyProvider, log);
    if (transcripts.length === 0) {
      await ctx.reply(`No chat history in the last ${hours}h to answer from.`);
      return;
    }
    try {
      const perChat = await summarizeTranscripts(provider, transcripts, { maxPoints: 14 }, log);
      const answer = await answerQuestion(provider, question, perChat, log);
      await sendLongMessage(ctx as unknown as Parameters<typeof sendLongMessage>[0], answer);
    } catch (err) {
      log.error({ err }, "ask failed");
      await ctx.reply("Ask failed.").catch(() => {});
    }
  });

  bot.command("join", async (ctx: Context) => {
    const raw = extractArgs(ctx);
    if (!raw) {
      await ctx.reply("Usage: /join <invite link>  — e.g. /join https://t.me/+AbCdEf");
      return;
    }
    // MTProto-only: need TelegramClient to importChatInvite / joinChannel
    if (!hasMtprotoConfig()) {
      await ctx.reply("Join requires MTProto config (TELEGRAM_API_ID/HASH/SESSION_B64). Bot-API mode cannot join chats.");
      return;
    }
    // Lazy GramJS path — avoid top-level import
    await ctx.sendChatAction("typing").catch(() => {});
    try {
      const { createRequire } = await import("node:module");
      const req = createRequire(import.meta.url);
      const { TelegramClient } = req("telegram");
      const { StringSession } = req("telegram/sessions");
      const { Api } = req("telegram");
      const { getEnv: getEnv2 } = await import("../config/env.js");
      const env2 = getEnv2();
      const sessionStr = Buffer.from(String(env2.SESSION_B64 ?? ""), "base64").toString("utf-8").trim();
      const session = new StringSession(sessionStr);
      const client = new TelegramClient(session, Number(env2.TELEGRAM_API_ID), String(env2.TELEGRAM_API_HASH), { connectionRetries: 2 });
      await client.connect();
      const link = raw.trim();
      // Extract hash from invite link
      const m = link.match(/t\.me\/\+([A-Za-z0-9_-]+)/) ?? link.match(/t\.me\/joinchat\/([A-Za-z0-9_-]+)/);
      if (m) {
        const hash = m[1]!;
        await client.invoke(new Api.messages.ImportChatInvite({ hash }));
        await ctx.reply(`Joined invite ${hash}.`);
      } else {
        const usernameMatch = link.match(/t\.me\/([A-Za-z0-9_]+)/);
        const username = usernameMatch ? usernameMatch[1] : link.replace(/^@/, "");
        if (!username) {
          await ctx.reply("Could not parse link. Send an invite link (t.me/+...) or username (t.me/name or @name).");
        } else {
          await client.invoke(new Api.channels.JoinChannel({ channel: username }));
          await ctx.reply(`Joined @${username}.`);
        }
      }
      await client.disconnect().catch(() => {});
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err }, "join failed");
      await ctx.reply(`Join failed: ${msg.slice(0, 800)}`).catch(() => {});
    }
  });
}
