/**
 * Transcript formatting — TypeScript port of telegram-summarizer fetch.py helpers.
 *
 * - describeMedia: tags a message with its media type
 * - formatMessage: one line per Telegram message, truncated to MAX_MSG_CHARS
 * - chunkLines: bin-pack lines into chunks under CHUNK_CHARS
 * - buildTranscript: header + chunked lines
 */
import { getEnv } from "../config/env.js";

export interface DigestMessage {
  date: Date;
  senderName: string;
  text: string;
  /** Optional media hint e.g. "[photo]", "[document: report.pdf]" */
  mediaTag?: string;
  isAction?: boolean;
}

export interface TranscriptResult {
  title: string;
  chatId: string | number;
  transcript: string;
  chunks: string[];
  messageCount: number;
}

/**
 * Describe media for a message — mirrors Python describe_media.
 */
export function describeMediaKind(kind: string, detail?: string): string {
  switch (kind) {
    case "webpage":
      return `[link: ${detail ?? "webpage"}]`;
    case "photo":
      return "[photo]";
    case "document":
      return detail ? `[document: ${detail}]` : "[document]";
    case "poll":
      return detail ? `[poll: ${detail}]` : "[poll]";
    case "geo":
      return detail ? `[location: ${detail}]` : "[location]";
    case "contact":
      return "[contact]";
    default:
      return detail ? `[${kind}: ${detail}]` : `[${kind}]`;
  }
}

/**
 * Format one message line: "[YYYY-MM-DD HH:MM] Sender: text [media]"
 * Skips action messages, truncates to env.MAX_MSG_CHARS.
 */
export function formatMessage(msg: DigestMessage): string | null {
  if (msg.isAction) return null;
  const env = getEnv();
  const maxChars = env.MAX_MSG_CHARS ?? 280;
  const clock = msg.date
    .toISOString()
    .slice(0, 16)
    .replace("T", " ");

  let line = `[${clock}] ${msg.senderName}: `;
  let body = msg.text ?? "";
  if (msg.mediaTag) body = body ? `${body} ${msg.mediaTag}` : msg.mediaTag;
  if (!body.trim()) return null;

  // Collapse whitespace/newlines like Python's " ".join(raw.split())
  body = body.replace(/\s+/g, " ").trim();
  if (body.length > maxChars) body = `${body.slice(0, maxChars)}…`;
  line += body;
  return line;
}

/**
 * Bin-pack lines into chunks not exceeding `maxChars`.
 * Mirrors Python chunk_lines.
 */
export function chunkLines(
  lines: string[],
  maxChars: number,
): string[] {
  if (lines.length === 0) return [];
  const chunks: string[] = [];
  let current: string[] = [];
  let currentLen = 0;

  for (const line of lines) {
    const len = line.length + 1; // + newline
    if (current.length > 0 && currentLen + len > maxChars) {
      chunks.push(current.join("\n"));
      current = [line];
      currentLen = len;
    } else {
      current.push(line);
      currentLen += len;
    }
  }
  if (current.length > 0) chunks.push(current.join("\n"));
  return chunks;
}

/**
 * Build a transcript string from messages.
 * header form: "CHAT: Title (id=..., username=@...) — 2026-09-04T10:00:00.000Z -> now"
 */
export function buildTranscript(
  messages: DigestMessage[],
  meta: { title: string; chatId: string | number; username?: string },
  sinceUtc: Date,
): TranscriptResult {
  const env = getEnv();
  const chunkChars = env.CHUNK_CHARS ?? 15_000;

  const lines: string[] = [];
  for (const m of messages) {
    if (m.date < sinceUtc) continue;
    const line = formatMessage(m);
    if (line) lines.push(line);
  }

  const headerParts = [`CHAT: ${meta.title} (id=${meta.chatId}`];
  if (meta.username) headerParts.push(`, username=@${meta.username}`);
  headerParts.push(`) — ${sinceUtc.toISOString()} -> now`);
  const header = headerParts.join("");

  const bodyChunks = chunkLines(lines, chunkChars);
  const chunks = bodyChunks.map((c) => `${header}\n${c}`);
  // Even empty chats get a single chunk with just the header
  if (chunks.length === 0) chunks.push(header);

  return {
    title: meta.title,
    chatId: meta.chatId,
    transcript: chunks.join("\n\n---\n\n"),
    chunks,
    messageCount: lines.length,
  };
}

/**
 * Split a long text for Telegram (3900-char limit like Python's split_for_telegram)
 * but re-exported here for digest consumers that need the tighter limit.
 */
export function splitForTelegram(text: string, limit = 3900): string[] {
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += limit) {
    parts.push(text.slice(i, i + limit));
  }
  return parts.length > 0 ? parts : [text];
}
