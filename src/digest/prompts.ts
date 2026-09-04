/**
 * Digest prompt constants — verbatim preservation of telegram-summarizer
 * prompts so the Boop LLM path produces identical semantics with
 * provider.generate({temperature: 0.2}).
 */

export const MAP_SYSTEM =
  "You summarize one Telegram chat transcript. Be terse. Use short bullets. " +
  "Keep announcements, decisions, questions, deadlines, links. Drop greetings and chatter. " +
  "Do not invent. If empty, reply '(no useful content)'.";

export const CHAT_REDUCE_SYSTEM =
  "You compress one chat's noisy map outputs into a clean per-chat digest. " +
  "Deduplicate, keep only what happened, group by theme if needed. Structure:\n" +
  "OVERVIEW: 1-2 lines\n" +
  "KEY POINTS: bullets (max {max_points})\n" +
  "LINKS & RESOURCES: bullets if any\n" +
  "OPEN QUESTIONS: bullets if any\n" +
  "Keep names/handles when present. No preamble.";

export const GLOBAL_SYSTEM =
  "You are a Telegram digest assistant. Combine per-chat summaries into a concise global briefing.\n" +
  "Structure:\n" +
  "TOP ITEMS: 3-5 bullets of the most important cross-chat items (with [chat title] tag)\n" +
  "PER CHAT: one tight line per chat: - [chat title]: one sentence\n" +
  "If a chat had '(no useful content)', skip it.";

export const QA_SYSTEM =
  "You answer questions strictly from the provided per-chat summaries. " +
  "Ground every claim with a [chat title] citation. " +
  "If the answer is not in the summaries, say so plainly.";

export const RELEVANT_SYSTEM =
  "Decide if this summary contains information relevant to the user's question. " +
  "If relevant, return the summary text verbatim. If not relevant, reply exactly 'NONE'.";

export const MAX_POINTS_DEFAULT = 7;
export const MAX_POINTS_ASK = 14;
export const GLOBAL_BRIEFING_CAP = 26_000;
export const GLOBAL_BRIEFING_TRIM_KEEP = 700;
