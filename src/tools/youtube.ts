import type { Logger } from "../config/logger.js";
import { YoutubeTranscript } from "youtube-transcript";

export interface YouTubeInfo {
  videoId: string;
  title?: string;
  channel?: string;
  transcript?: string;
  transcriptLang?: string;
  /** Non-fatal caveats to surface to the model (e.g. "no captions"). */
  notes: string[];
}

/**
 * Extract an 11-char YouTube video id from any common link shape:
 * watch, youtu.be, shorts, embed, live, /v/, nocookie. Returns null for
 * non-YouTube URLs so the caller can fall through to normal fetching.
 */
export function extractYouTubeId(rawUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }

  const host = u.hostname.replace(/^www\./i, "").toLowerCase();
  const idPattern = /^[A-Za-z0-9_-]{11}$/;

  if (host === "youtu.be") {
    const id = u.pathname.slice(1).split("/")[0];
    return id && idPattern.test(id) ? id : null;
  }
  if (!/(^|\.)youtube\.com$/.test(host) && host !== "youtube-nocookie.com") {
    return null;
  }
  if (u.pathname === "/watch") {
    const id = u.searchParams.get("v") ?? "";
    return idPattern.test(id) ? id : null;
  }
  const m = u.pathname.match(/\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

/**
 * Fetch what a YouTube link points to: metadata via oEmbed plus the caption
 * transcript when one exists. Never throws — failures become notes.
 */
export async function fetchYouTubeInfo(videoId: string, log: Logger): Promise<YouTubeInfo> {
  const info: YouTubeInfo = { videoId, notes: [] };

  // Metadata — oEmbed needs no API key and works for public videos.
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (res.ok) {
      const data = (await res.json()) as { title?: string; author_name?: string };
      info.title = data.title;
      info.channel = data.author_name;
    } else if ([400, 401, 403, 404].includes(res.status)) {
      info.notes.push("Video appears private, deleted, or unavailable.");
      return info;
    } else {
      log.warn({ status: res.status }, "YouTube oEmbed failed");
    }
  } catch (err) {
    log.warn({ err }, "YouTube oEmbed request failed");
  }

  // Transcript — package tries InnerTube first, web-page scrape as fallback.
  // Prefer English captions; if only other languages exist, take one of those.
  try {
    let parts;
    try {
      parts = await YoutubeTranscript.fetchTranscript(videoId, { lang: "en" });
    } catch (err) {
      if (!isLanguageError(err)) throw err;
      parts = await YoutubeTranscript.fetchTranscript(videoId);
      const got = parts[0]?.lang ?? "a non-English";
      info.notes.push(`No English captions — showing ${got} captions instead.`);
    }

    const text = parts.map((p) => p.text.replace(/\s+/g, " ").trim()).join(" ");
    if (text.trim()) {
      info.transcript = text;
      info.transcriptLang = parts[0]?.lang ?? undefined;
    } else {
      info.notes.push("Captions exist but contained no text.");
    }
  } catch (err) {
    info.notes.push(describeTranscriptError(err, videoId));
  }

  return info;
}

function isLanguageError(err: unknown): boolean {
  return (
    err instanceof Error && err.constructor.name === "YoutubeTranscriptNotAvailableLanguageError"
  );
}

/** Map known youtube-transcript failure modes to model-friendly wording. */
function describeTranscriptError(err: unknown, videoId: string): string {
  const name = err instanceof Error ? err.constructor.name : "";
  switch (name) {
    case "YoutubeTranscriptTooManyRequestError":
      return "YouTube is rate-limiting this server's IP for transcripts right now — retry shortly.";
    case "YoutubeTranscriptVideoUnavailableError":
      return "The video is unavailable.";
    case "YoutubeTranscriptDisabledError":
      return "The uploader disabled captions on this video.";
    case "YoutubeTranscriptNotAvailableError":
      return `No captions are available for video ${videoId}.`;
    case "YoutubeTranscriptNotAvailableLanguageError": {
      const langs = (err as unknown as { availableLangs?: string[] }).availableLangs ?? [];
      return `No English captions; available languages: ${langs.join(", ") || "unknown"}.`;
    }
    default:
      return err instanceof Error
        ? `Transcript fetch failed: ${err.message}`
        : "Transcript fetch failed.";
  }
}

/** Format a fetched YouTubeInfo as tool output text. */
export function formatYouTubeOutput(info: YouTubeInfo, maxLength: number): string {
  const lines: string[] = ["Type: YouTube video"];
  if (info.title) lines.push(`Title: ${info.title}`);
  if (info.channel) lines.push(`Channel: ${info.channel}`);
  lines.push(`Source: https://www.youtube.com/watch?v=${info.videoId}`);
  for (const n of info.notes) lines.push(`Note: ${n}`);
  lines.push("");

  const header = lines.join("\n");

  if (!info.transcript) {
    return `${header}\nNo transcript could be retrieved, so the spoken content is unknown.`;
  }

  const room = Math.max(maxLength - header.length - 60, 500);
  const transcript =
    info.transcript.length <= room
      ? info.transcript
      : `${info.transcript.slice(0, room)}\n\n[...transcript truncated at ${room} of ${info.transcript.length} characters]`;

  const langLine = info.transcriptLang ? ` (${info.transcriptLang})` : "";
  return `${header}\nTranscript${langLine}:\n${transcript}`;
}
