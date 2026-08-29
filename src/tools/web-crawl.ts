import * as cheerio from "cheerio";
import type { Logger } from "../config/logger.js";
import type { Tool, ToolResult } from "./types.js";
import {
  authHeadersFor,
  blockedHostReason,
  extractFromBuffer,
  htmlToReadableText,
  MAX_BYTES,
} from "./web-fetch.js";
import { extractYouTubeId, fetchYouTubeInfo, formatYouTubeOutput } from "./youtube.js";

const FETCH_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_PAGES = 8;
const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_MAX_CHARS_PER_PAGE = 4000;

/**
 * Web crawler / scraper — multi-page BFS crawler built on top of web_fetch.
 *
 * Reuses every guard from web_fetch: SSRF blockedHostReason, WEB_FETCH_HEADERS
 * subdomain-aware longest-match, browser UA, 10 MB / 20 s caps, YouTube
 * special-casing, unpdf/cheerio extraction. Adds:
 *  - BFS queue with visited Set (normalized, hash-stripped)
 *  - same-domain filtering (default strict same-host)
 *  - paywall detection before JUNK stripping
 *  - link extraction via cheerio a[href] → absolute URL + blocklist filtering
 *  - polite per-fetch pacing (tiny delay) + hard per-page truncation
 */
export function createWebCrawlTool(logger: Logger): Tool {
  const log = logger.child({ component: "WebCrawlTool" });

  return {
    definition: {
      name: "web_crawl",
      description:
        "Crawl a website starting from a URL — follows same-site links (BFS) " +
        "and returns the readable text of every page visited. Use this when the user " +
        "wants you to scrape a section, follow links, map a site, or read beyond a " +
        "single page. Single-page reads should still use web_fetch. " +
        "Handles paywalled pages honestly (notes truncation), reuses the SSRF guard " +
        "and domain auth headers from web_fetch, and caps pages/depth to stay fast.",
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The starting URL to crawl (must be http:// or https://)",
          },
          maxPages: {
            type: "number",
            description: "Maximum pages to fetch (1-20, default 8)",
            default: DEFAULT_MAX_PAGES,
          },
          maxDepth: {
            type: "number",
            description: "Maximum link depth from the start URL (0-3, default 2). 0 = only the start page.",
            default: DEFAULT_MAX_DEPTH,
          },
          sameDomain: {
            type: "boolean",
            description: "When true (default), only follow links on the same host as the start URL.",
            default: true,
          },
          maxCharsPerPage: {
            type: "number",
            description: "Maximum characters of readable text per page in the output (500-12000, default 4000)",
            default: DEFAULT_MAX_CHARS_PER_PAGE,
          },
        },
        required: ["url"],
      },
    },

    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const rawUrl = String(args.url ?? "").trim();
      const maxPages = clampInt(args.maxPages, 1, 20, DEFAULT_MAX_PAGES);
      const maxDepth = clampInt(args.maxDepth, 0, 3, DEFAULT_MAX_DEPTH);
      const sameDomain = typeof args.sameDomain === "boolean" ? args.sameDomain : true;
      const maxCharsPerPage = clampInt(
        args.maxCharsPerPage,
        500,
        12000,
        DEFAULT_MAX_CHARS_PER_PAGE,
      );

      if (!rawUrl) return fail("URL is required");

      let startParsed: URL;
      try {
        startParsed = new URL(rawUrl);
      } catch {
        return fail(
          `"${rawUrl}" is not a web address. web_crawl needs an http(s) URL to start from.`,
        );
      }

      if (startParsed.protocol === "mailto:" || startParsed.protocol === "tel:") {
        return fail(
          `${startParsed.protocol} links have no pages to crawl — use web_fetch to describe them.`,
        );
      }
      if (startParsed.protocol === "file:") {
        return fail("file:// URLs cannot be crawled (cloud host — no local filesystem).");
      }
      if (startParsed.protocol !== "http:" && startParsed.protocol !== "https:") {
        return fail(`Unsupported protocol "${startParsed.protocol}" — only http(s) can be crawled.`);
      }

      const blocked = blockedHostReason(startParsed.hostname);
      if (blocked) return fail(blocked);

      const ytId = extractYouTubeId(rawUrl);
      if (ytId) {
        log.debug({ rawUrl, ytId }, "Start URL is YouTube — delegating to single-page path");
        const info = await fetchYouTubeInfo(ytId, log);
        return {
          toolName: "web_crawl",
          args,
          output:
            `Note: starting URL is a YouTube video — crawled as a single page (no links to follow).\n\n` +
            formatYouTubeOutput(info, 8000),
          success: true,
        };
      }

      const startHost = startParsed.hostname.toLowerCase();
      const visited = new Set<string>();
      const queue: Array<{ url: string; depth: number }> = [{ url: rawUrl, depth: 0 }];
      const pages: CrawledPage[] = [];
      const failures: Array<{ url: string; reason: string }> = [];
      const seenForDedup = new Set<string>([normalizeUrl(rawUrl)]);

      log.info({ start: rawUrl, maxPages, maxDepth, sameDomain }, "Crawl started");

      while (queue.length > 0 && pages.length < maxPages) {
        const cur = queue.shift()!;
        const norm = normalizeUrl(cur.url);
        if (visited.has(norm)) continue;
        visited.add(norm);

        // Polite micro-delay between fetches — avoids hammering small hosts.
        if (pages.length > 0) await sleep(180);

        const result = await fetchSinglePage(cur.url, log);
        if (!result.ok) {
          failures.push({ url: cur.url, reason: result.error });
          log.warn({ url: cur.url, error: result.error }, "Page fetch failed — continuing crawl");
          continue;
        }

        const { finalUrl, buffer, contentType } = result;
        const finalHost = (() => {
          try {
            return new URL(finalUrl).hostname.toLowerCase();
          } catch {
            return startHost;
          }
        })();

        // sameDomain bail — redirect landed off-host
        if (sameDomain && finalHost !== startHost) {
          failures.push({ url: cur.url, reason: `Redirected off-host to ${finalHost} — skipped` });
          continue;
        }

        const ctLower = contentType.toLowerCase();
        const isHtml = ctLower.includes("html") || ctLower.includes("xhtml");

        let title: string | undefined;
        let published: string | undefined;
        let body = "";
        let note: string | undefined;
        let links: string[] = [];
        let paywalled = false;

        if (isHtml) {
          const html = new TextDecoder("utf-8").decode(buffer);
          paywalled = detectPaywall(html);
          const extracted = htmlToReadableText(html, finalUrl);
          title = extracted.title;
          published = extracted.published;
          body = extracted.text;
          if (paywalled && !body.toLowerCase().includes("paywall")) {
            note =
              "This page appears to be partially paywalled — some content is hidden behind a subscription. Visible portion shown.";
          }
          if (cur.depth < maxDepth) {
            const rawLinks = extractLinks(html, finalUrl);
            links = rawLinks.filter((href) => shouldFollowLink(href, startHost, sameDomain, seenForDedup));
            for (const href of links) {
              const n = normalizeUrl(href);
              if (!seenForDedup.has(n) && pages.length + queue.length < maxPages * 3) {
                seenForDedup.add(n);
                queue.push({ url: href, depth: cur.depth + 1 });
              }
            }
          }
        } else {
          // Non-HTML leaf — extract via shared pipeline but never follow links.
          try {
            const extracted = await extractFromBuffer(buffer, {
              contentType,
              url: finalUrl,
            });
            title = extracted.title;
            published = extracted.published;
            body = extracted.body;
            note = extracted.note;
          } catch (e) {
            failures.push({
              url: cur.url,
              reason: `Non-HTML extraction failed: ${e instanceof Error ? e.message : String(e)}`,
            });
            continue;
          }
        }

        pages.push({
          url: finalUrl,
          title,
          published,
          body,
          note,
          contentType: contentType.split(";")[0].trim() || "unknown",
          depth: cur.depth,
          linksFound: links.length,
          paywalled,
        });
      }

      if (pages.length === 0) {
        const failDetail =
          failures.length > 0
            ? failures
                .slice(0, 5)
                .map((f) => `• ${f.url} — ${f.reason}`)
                .join("\n")
            : "No pages could be retrieved.";
        return {
          toolName: "web_crawl",
          args,
          output:
            `Crawl starting from ${rawUrl} produced no readable pages.\n` +
            `Visited ${visited.size} URL(s), ${failures.length} failed.\n\nFailures:\n${failDetail}`,
          success: true,
        };
      }

      // Format aggregated output — header + per-page blocks + Sources footer
      const header = [
        `Crawled ${pages.length} page(s) starting from ${rawUrl}`,
        `Settings: maxPages=${maxPages} maxDepth=${maxDepth} sameDomain=${sameDomain} maxCharsPerPage=${maxCharsPerPage}`,
        `Stats: visited ${visited.size} URL(s), ${failures.length} failed, queued ${queue.length} remaining`,
        pages.some((p) => p.paywalled) ? "Note: one or more pages appear paywalled — truncated after the free preview." : undefined,
      ]
        .filter(Boolean)
        .join(" | ");

      const blocks: string[] = [header, ""];

      for (let i = 0; i < pages.length; i++) {
        const p = pages[i];
        const clipped =
          p.body.length > maxCharsPerPage
            ? `${p.body.slice(0, maxCharsPerPage)}\n\n[...page truncated at ${maxCharsPerPage} of ${p.body.length} characters]`
            : p.body;

        blocks.push(`## ${i + 1}. ${p.title ?? "(untitled)"}`);
        blocks.push(`Source: ${p.url}`);
        blocks.push(`Depth: ${p.depth} | Type: ${p.contentType}${p.published ? ` | Published: ${p.published}` : ""}${p.paywalled ? " | Paywalled: partial" : ""}`);
        if (p.note) blocks.push(`Note: ${p.note}`);
        blocks.push("");
        blocks.push(clipped || "(No readable text extracted)");
        if (p.linksFound > 0) blocks.push("", `Links discovered on this page: ${p.linksFound} (followed up to remaining budget)`);
        blocks.push("", "---", "");
      }

      if (failures.length > 0) {
        blocks.push(`### Failures (${failures.length})`);
        for (const f of failures.slice(0, 8)) blocks.push(`- ${f.url} — ${f.reason}`);
        if (failures.length > 8) blocks.push(`- ... and ${failures.length - 8} more`);
        blocks.push("");
      }

      blocks.push("### Sources");
      for (let i = 0; i < pages.length; i++) {
        blocks.push(`${i + 1}. ${pages[i].title ?? pages[i].url} — ${pages[i].url}`);
      }

      return { toolName: "web_crawl", args, output: blocks.join("\n"), success: true };
    },
  };
}

interface CrawledPage {
  url: string;
  title?: string;
  published?: string;
  body: string;
  note?: string;
  contentType: string;
  depth: number;
  linksFound: number;
  paywalled: boolean;
}

function fail(error: string): ToolResult {
  return { toolName: "web_crawl", args: {}, output: "", success: false, error };
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.round(n), min), max);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── URL normalization ─────────────────────────────────────────────────

export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    // Collapse default ports for dedup
    if ((u.protocol === "https:" && u.port === "443") || (u.protocol === "http:" && u.port === "80")) {
      u.port = "";
    }
    // Strip trailing slash on non-root paths for dedup, keep root as /
    // Use lowercase host — path stays case-sensitive.
    u.hostname = u.hostname.toLowerCase();
    return u.toString();
  } catch {
    return raw;
  }
}

// ── Link extraction ──────────────────────────────────────────────────

export function extractLinks(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const out: string[] = [];
  const seen = new Set<string>();
  $("a[href]").each((_, el) => {
    const raw = $(el).attr("href")?.trim();
    if (!raw) return;
    // Skip fragments, js, data
    if (
      raw.startsWith("#") ||
      raw.startsWith("javascript:") ||
      raw.startsWith("data:") ||
      raw.startsWith("mailto:") ||
      raw.startsWith("tel:") ||
      raw.startsWith("blob:")
    ) {
      return;
    }
    const abs = absoluteUrl(raw, baseUrl);
    if (!abs) return;
    let parsed: URL;
    try {
      parsed = new URL(abs);
    } catch {
      return;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
    const norm = normalizeUrl(abs);
    if (seen.has(norm)) return;
    seen.add(norm);
    out.push(abs);
  });
  return out;
}

export function shouldFollowLink(
  href: string,
  startHost: string,
  sameDomain: boolean,
  seenForDedup: Set<string>,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  if (blockedHostReason(host)) return false;
  if (sameDomain && host !== startHost) return false;
  const norm = normalizeUrl(href);
  if (seenForDedup.has(norm)) return false;
  return true;
}

function absoluteUrl(href: string | undefined, baseUrl: string): string | undefined {
  if (!href) return undefined;
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return undefined;
  }
}

// ── Paywall detection (check BEFORE JUNK removal) ────────────────────

const PAYWALL_HINTS = [
  "paywall",
  "subscribe to read",
  "paid content",
  "available for paid subscribers",
  "this post is for paid subscribers",
  "upgrade to paid",
];

export function detectPaywall(html: string): boolean {
  const lower = html.toLowerCase();
  // Class / id markers
  if (
    lower.includes('class="paywall') ||
    lower.includes("class='paywall") ||
    lower.includes('id="paywall') ||
    lower.includes("available-content") ||
    lower.includes("paywall-gate") ||
    lower.includes("subscription-wall")
  ) {
    return true;
  }
  for (const hint of PAYWALL_HINTS) {
    if (lower.includes(hint)) return true;
  }
  return false;
}

// ── Single-page fetch (mirrors web_fetch guards) ─────────────────────

interface FetchOk {
  ok: true;
  finalUrl: string;
  buffer: ArrayBuffer;
  contentType: string;
}
interface FetchErr {
  ok: false;
  error: string;
}

async function fetchSinglePage(url: string, log: Logger): Promise<FetchOk | FetchErr> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (e) {
    return { ok: false, error: `Invalid URL: ${String(e)}` };
  }
  const blocked = blockedHostReason(parsed.hostname);
  if (blocked) return { ok: false, error: blocked };

  // Respect per-domain auth headers (same as web_fetch)
  const extraHeaders = authHeadersFor(parsed.hostname, log);

  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/pdf,text/plain,application/json;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        ...extraHeaders,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status} ${res.statusText}` };
    }

    const contentType = res.headers.get("content-type") ?? "";
    const declaredLength = Number(res.headers.get("content-length") ?? 0);
    if (declaredLength > MAX_BYTES) {
      return { ok: false, error: `File too large (${(declaredLength / 1e6).toFixed(1)} MB)` };
    }

    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > MAX_BYTES) {
      return { ok: false, error: `File too large (${(buffer.byteLength / 1e6).toFixed(1)} MB)` };
    }

    return {
      ok: true,
      finalUrl: res.url || url,
      buffer,
      contentType,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg === "TimeoutError" ? "Request timed out" : msg };
  }
}
