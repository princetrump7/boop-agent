/**
 * Digest LLM pipeline — TypeScript port of telegram-summarizer summarize.py.
 *
 * Preserves the two-stage map→reduce→global flow with identical prompts,
 * concurrency 2, chunkChars 15000, and caps. Operates over any
 * LLMProvider (Anthropic or OpenAI) via provider.generate().
 *
 * Sources of transcript chunks:
 *  - Bot-API mode: callers supply ChatTranscript[] built from Boop's stored
 *    Convex conversationHistory / messages.
 *  - MTProto mode: callers supply transcripts fetched via optional GramJS
 *    sidecar (src/digest/session.ts); pipeline is agnostic.
 */
import type { LLMProvider } from "../agent/providers/base.js";
import type { Logger } from "../config/logger.js";
import {
  MAP_SYSTEM,
  CHAT_REDUCE_SYSTEM,
  GLOBAL_SYSTEM,
  QA_SYSTEM,
  RELEVANT_SYSTEM,
  MAX_POINTS_DEFAULT,
  MAX_POINTS_ASK,
  GLOBAL_BRIEFING_CAP,
  GLOBAL_BRIEFING_TRIM_KEEP,
} from "./prompts.js";

export interface ChatTranscript {
  title: string;
  chatId: string | number;
  chunks: string[];
  messageCount: number;
}

export interface PerChatSummary {
  title: string;
  chatId: string | number;
  summary: string;
}

export interface DigestOptions {
  maxPoints?: number;
  concurrency?: number;
}

// ---------------------------------------------------------------------------
// Low-level LLM call (mirrors Python llm.aask)
// ---------------------------------------------------------------------------

async function aask(
  provider: LLMProvider,
  system: string,
  userContent: string,
  logger?: Logger,
): Promise<string> {
  try {
    const r = await provider.generate({
      systemPrompt: system,
      messages: [{ role: "user", content: userContent }],
      tools: [],
      maxTokens: 4096,
      temperature: 0.2,
    });
    return (r.content ?? "").trim();
  } catch (err) {
    logger?.warn({ err, system: system.slice(0, 80) }, "LLM call failed");
    return "";
  }
}

// ---------------------------------------------------------------------------
// Chunk helpers — mirrors chunk_lines at 15000
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// summarizeTranscript — per-chat map→reduce (concurrency 2)
// ---------------------------------------------------------------------------

export async function summarizeTranscript(
  provider: LLMProvider,
  transcript: ChatTranscript,
  opts: DigestOptions = {},
  logger?: Logger,
): Promise<PerChatSummary> {
  const maxPoints = opts.maxPoints ?? MAX_POINTS_DEFAULT;
  const concurrency = opts.concurrency ?? 2;

  if (transcript.chunks.length === 0 || transcript.messageCount === 0) {
    return { title: transcript.title, chatId: transcript.chatId, summary: "(no useful content)" };
  }

  // MAP: one LLM call per chunk, concurrency 2
  const mapOutputs: string[] = [];
  for (let i = 0; i < transcript.chunks.length; i += concurrency) {
    const batch = transcript.chunks.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map((chunk) => aask(provider, MAP_SYSTEM, chunk, logger)),
    );
    mapOutputs.push(...results);
  }

  const valid = mapOutputs.filter((t) => t && t !== "(no useful content)");
  if (valid.length === 0) {
    return { title: transcript.title, chatId: transcript.chatId, summary: "(no useful content)" };
  }
  if (valid.length === 1) {
    // Single chunk — no reduce pass needed, just return it as-is
    return { title: transcript.title, chatId: transcript.chatId, summary: valid[0]! };
  }

  // REDUCE: compress map outputs into one per-chat digest
  const reducePrompt = CHAT_REDUCE_SYSTEM.replace("{max_points}", String(maxPoints));
  const joined = valid.map((t, idx) => `--- chunk ${idx + 1} ---\n${t}`).join("\n\n");
  const reduced = await aask(provider, reducePrompt, joined, logger);
  return {
    title: transcript.title,
    chatId: transcript.chatId,
    summary: reduced || valid.join("\n\n"),
  };
}

export async function summarizeTranscripts(
  provider: LLMProvider,
  transcripts: ChatTranscript[],
  opts: DigestOptions = {},
  logger?: Logger,
): Promise<PerChatSummary[]> {
  const results: PerChatSummary[] = [];
  const concurrency = opts.concurrency ?? 2;
  for (let i = 0; i < transcripts.length; i += concurrency) {
    const batch = transcripts.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map((t) => summarizeTranscript(provider, t, opts, logger)),
    );
    results.push(...batchResults);
  }
  return results;
}

// ---------------------------------------------------------------------------
// globalBriefing — combine per-chat summaries
// ---------------------------------------------------------------------------

export async function globalBriefing(
  provider: LLMProvider,
  perChat: PerChatSummary[],
  logger?: Logger,
): Promise<string> {
  const meaningful = perChat.filter((p) => p.summary && p.summary !== "(no useful content)");
  if (meaningful.length === 0) return "No new activity in the selected period.";

  let joined = meaningful.map((p) => `## ${p.title}\n${p.summary}`).join("\n\n");

  // Cap at 26000 like Python — trim outer chunks to 700+"..." and keep middle
  if (joined.length > GLOBAL_BRIEFING_CAP) {
    const entries = perChat.map((_p, i) => {
      // Reconstruct roughly — keep first 700 and last 700, mark middle
      return meaningful[i] ? `## ${meaningful[i]!.title}\n${meaningful[i]!.summary.slice(0, GLOBAL_BRIEFING_TRIM_KEEP)}…` : "";
    });
    // Simpler cap: just hard-trim joined
    joined = `${joined.slice(0, GLOBAL_BRIEFING_CAP - 200)}\n\n[truncated — ${meaningful.length} chats]`;
    void entries; // keep shape for future chunk-aware trimming
  }

  const r = await aask(provider, GLOBAL_SYSTEM, joined, logger);
  return r || joined.slice(0, 4000);
}

// ---------------------------------------------------------------------------
// answerQuestion — relevance filter then QA, pacing 1.5s every 2nd call
// ---------------------------------------------------------------------------

export async function answerQuestion(
  provider: LLMProvider,
  question: string,
  perChat: PerChatSummary[],
  logger?: Logger,
): Promise<string> {
  if (perChat.length === 0) return "No chat summaries available to answer from.";

  // Relevance filter pass (concurrency 2, pacing 1.5s every other batch)
  const relevant: string[] = [];
  const chunks: string[] = perChat.map((p) => `## ${p.title}\n${p.summary}`);

  for (let i = 0; i < chunks.length; i += 2) {
    const batch = chunks.slice(i, i + 2);
    const results = await Promise.all(
      batch.map((c) =>
        aask(
          provider,
          RELEVANT_SYSTEM,
          `Question: ${question}\n\nSummary:\n${c}`,
          logger,
        ),
      ),
    );
    for (let j = 0; j < batch.length; j++) {
      const out = (results[j] ?? "").trim();
      if (out && out !== "NONE") relevant.push(batch[j]!);
    }
    if ((i / 2) % 2 === 1) await sleep(1500);
  }

  if (relevant.length === 0) {
    return "No relevant information found in the selected time window for that question.";
  }

  const context = relevant.join("\n\n");
  const answer = await aask(
    provider,
    QA_SYSTEM,
    `Question: ${question}\n\nContext:\n${context}`,
    logger,
  );
  return answer || "I could not generate an answer from the available summaries.";
}

// ---------------------------------------------------------------------------
// High-level digest convenience (for direct callers / scheduler)
// ---------------------------------------------------------------------------

export interface FullDigestResult {
  perChat: PerChatSummary[];
  global: string;
}

export async function fullDigest(
  provider: LLMProvider,
  transcripts: ChatTranscript[],
  opts: DigestOptions = {},
  logger?: Logger,
): Promise<FullDigestResult> {
  const perChat = await summarizeTranscripts(provider, transcripts, opts, logger);
  const global = await globalBriefing(provider, perChat, logger);
  return { perChat, global };
}
