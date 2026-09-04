import type { Logger } from "../config/logger.js";
import type { Tool, ToolResult } from "./types.js";
import { getEnv, hasMtprotoConfig } from "../config/env.js";
import { createLLMProviderFromEnv } from "../agent/providers/factory.js";
import { globalBriefing, summarizeTranscripts, answerQuestion } from "../digest/pipeline.js";
import { collectBotApiTranscripts, fetchMtprotoTranscripts } from "../digest/session.js";
import type { ChatTranscript } from "../digest/pipeline.js";
import type { BotApiChatHistory } from "../digest/session.js";

/**
 * Digest tool factory.
 *
 * Exposes two LLM-callable tools:
 *  - digest_chats: summarize chats in the last N hours (Bot-API or MTProto)
 *  - ask_chats:   Q&A grounded in those summaries
 *
 * Both tools reuse the telegram-summarizer map→reduce→global prompts via
 * provider.generate({temperature: 0.2}) with concurrency 2, chunkChars 15000.
 *
 * Bot-API mode reads from an injected history-provider callback (supplied by
 * orchestrator wiring). MTProto mode, when configured, is preferred and
 * fetches directly via GramJS.
 */

export type HistoryProvider = () => BotApiChatHistory[] | Promise<BotApiChatHistory[]>;

function parseHours(raw: unknown): number {
  const env = getEnv();
  const fallback = env.DEFAULT_HOURS ?? 24;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, 168); // cap 7 days
}

async function resolveTranscripts(
  hours: number,
  findEntity: string | undefined,
  historyProvider: HistoryProvider | undefined,
  logger: Logger,
): Promise<ChatTranscript[]> {
  const env = getEnv();
  const sinceUtc = new Date(Date.now() - hours * 60 * 60 * 1000);
  const maxMessages = env.MAX_MESSAGES ?? 800;
  const maxChats = env.MAX_CHATS ?? 25;

  // Try MTProto first if configured
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
    // Fall through to Bot-API if MTProto returned nothing
  }

  if (!historyProvider) return [];
  const histories = await historyProvider();
  return collectBotApiTranscripts(
    histories,
    { sinceUtc, hourWindow: hours, maxMessages },
    logger,
  );
}

export function createDigestTools(
  logger: Logger,
  historyProvider?: HistoryProvider,
): Tool[] {
  const log = logger.child({ component: "DigestTools" });

  const digestChats: Tool = {
    definition: {
      name: "digest_chats",
      description:
        "Summarize recent Telegram chat activity in the last N hours. Returns a global briefing plus per-chat summaries. " +
        "In Bot-API mode this covers chats the bot has seen; with MTProto (TELEGRAM_API_ID/HASH + SESSION_B64) it covers all dialogs.",
      inputSchema: {
        type: "object",
        properties: {
          hours: { type: "number", description: "Lookback window in hours (default 24, max 168)" },
          chat_filter: { type: "string", description: "Optional chat name substring to filter (like /chat <name>)" },
          max_points: { type: "number", description: "Max bullet points per chat (default 7)" },
        },
      },
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const hours = parseHours(args["hours"]);
      const chatFilter = args["chat_filter"] ? String(args["chat_filter"]) : undefined;
      const maxPoints = Math.min(Math.max(Number(args["max_points"]) || 7, 1), 14);

      const provider = createLLMProviderFromEnv(log);
      const transcripts = await resolveTranscripts(hours, chatFilter, historyProvider, log);
      if (transcripts.length === 0) {
        return {
          toolName: "digest_chats",
          args,
          output: `No chat history found in the last ${hours}h${chatFilter ? ` matching "${chatFilter}"` : ""}. ` +
            `Bot-API mode only sees chats the bot has participated in; configure TELEGRAM_API_ID/TELEGRAM_API_HASH/SESSION_B64 for full dialog access.`,
          success: true,
        };
      }

      const filtered = chatFilter
        ? transcripts.filter((t) => t.title.toLowerCase().includes(chatFilter.toLowerCase()))
        : transcripts;
      if (filtered.length === 0) {
        return {
          toolName: "digest_chats",
          args,
          output: `No chats matching "${chatFilter}" in the last ${hours}h. Available: ${transcripts.map((t) => t.title).join(", ")}`,
          success: true,
        };
      }

      const perChat = await summarizeTranscripts(provider, filtered, { maxPoints }, log);
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
      return { toolName: "digest_chats", args, output: lines.join("\n"), success: true };
    },
  };

  const askChats: Tool = {
    definition: {
      name: "ask_chats",
      description:
        "Answer a question grounded strictly in recent chat summaries from the last N hours. Every claim is cited with [chat title]. " +
        "If the answer is not in the summaries, the model says so plainly.",
      inputSchema: {
        type: "object",
        properties: {
          question: { type: "string", description: "The question to answer from chat history" },
          hours: { type: "number", description: "Lookback window in hours (default 24, max 168)" },
          chat_filter: { type: "string", description: "Optional chat filter" },
        },
        required: ["question"],
      },
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const question = String(args["question"] ?? "").trim();
      if (!question) {
        return { toolName: "ask_chats", args, output: "", success: false, error: "question is required" };
      }
      const hours = parseHours(args["hours"]);
      const chatFilter = args["chat_filter"] ? String(args["chat_filter"]) : undefined;

      const provider = createLLMProviderFromEnv(log);
      const transcripts = await resolveTranscripts(hours, chatFilter, historyProvider, log);
      if (transcripts.length === 0) {
        return {
          toolName: "ask_chats",
          args,
          output: `No chat history in the last ${hours}h to answer from.`,
          success: true,
        };
      }
      const filtered = chatFilter
        ? transcripts.filter((t) => t.title.toLowerCase().includes(chatFilter.toLowerCase()))
        : transcripts;
      const perChat = await summarizeTranscripts(provider, filtered, { maxPoints: 14 }, log);
      const answer = await answerQuestion(provider, question, perChat, log);
      return { toolName: "ask_chats", args, output: answer, success: true };
    },
  };

  return [digestChats, askChats];
}
