import type { Logger } from "../config/logger.js";
import type { Tool, ToolResult } from "./types.js";
import * as cheerio from "cheerio";

/** Hard cap on bytes we are willing to download for a single link. */
const MAX_BYTES = 10 * 1024 * 1024;

const FETCH_TIMEOUT_MS = 20_000;

/**
 * Web fetch tool — reads a URL and returns what is actually at that link.
 *
 * Handles the content types links commonly point to:
 * - HTML pages → main article text extracted to readable markdown
 * - PDFs → extracted plain text (via unpdf)
 * - JSON / plain text / code → returned as-is
 * - Images and other media → a short metadata note
 */
export function createWebFetchTool(logger: Logger): Tool {
  const log = logger.child({ component: "WebFetchTool" });

  return {
    definition: {
      name: "web_fetch",
      description:
        "Read a URL and return its actual content. ALWAYS use this when the user sends a link — " +
        "never guess what a URL contains from its address alone. Works on articles, blog posts, " +
        "documentation, PDFs, JSON endpoints, and raw text files.",
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The URL to fetch (must start with http:// or https://)",
          },
          maxLength: {
            type: "number",
            description: "Maximum characters of content to return (default 12000)",
            default: 12000,
          },
        },
        required: ["url"],
      },
    },

    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const url = String(args.url ?? "").trim();
      const maxLength = Math.min(Math.max(Number(args.maxLength) || 12000, 500), 50000);

      if (!url) {
        return fail("URL is required");
      }

      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return fail(`Not a valid URL: ${url}`);
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return fail("Only http:// and https:// URLs are supported");
      }

      try {
        log.debug({ url }, "Fetching URL");

        const response = await fetch(url, {
          redirect: "follow",
          headers: {
            // A realistic browser UA — several sites 403 unknown bots outright.
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
            Accept:
              "text/html,application/xhtml+xml,application/pdf,text/plain,application/json;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
          },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });

        if (!response.ok) {
          return fail(`The site responded with HTTP ${response.status} (${response.statusText})`);
        }

        const contentType = (response.headers.get("content-type") ?? "").toLowerCase();

        // Guard against absurdly large downloads before buffering them.
        const declaredLength = Number(response.headers.get("content-length") ?? 0);
        if (declaredLength > MAX_BYTES) {
          return fail(`File too large to read (${(declaredLength / 1e6).toFixed(1)} MB)`);
        }

        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > MAX_BYTES) {
          return fail(`File too large to read (${(buffer.byteLength / 1e6).toFixed(1)} MB)`);
        }

        let body = "";
        let note: string | undefined;
        let pageTitle: string | undefined;
        let pagePublished: string | undefined;

        if (
          contentType.includes("application/pdf") ||
          parsed.pathname.toLowerCase().endsWith(".pdf")
        ) {
          body = await extractPdfText(buffer);
          if (!body) note = "PDF contained no extractable text (may be scanned images).";
        } else if (contentType.includes("html")) {
          const page = htmlToReadableText(decodeUtf8(buffer), url);
          body = page.text;
          if (page.title) pageTitle = page.title;
          if (page.published) pagePublished = page.published;
        } else if (contentType.includes("json")) {
          body = prettyJson(decodeUtf8(buffer));
        } else if (contentType.startsWith("text/") || looksLikeText(buffer)) {
          body = decodeUtf8(buffer);
        } else {
          note =
            `This link points to binary media (content-type: ${contentType || "unknown"}, ` +
            `${(buffer.byteLength / 1024).toFixed(0)} KB). Text extraction is not possible.`;
        }

        const meta = extractMeta(contentType, response.url || url);
        meta.title = pageTitle;
        meta.published = pagePublished;
        const output = formatOutput(meta, body, maxLength, note);

        return {
          toolName: "web_fetch",
          args,
          output,
          success: true,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ url, error: message }, "Web fetch failed");
        return fail(
          message === "TimeoutError"
            ? "The site took too long to respond"
            : `Failed to fetch: ${message}`,
        );
      }
    },
  };
}

function fail(error: string): ToolResult {
  return { toolName: "web_fetch", args: {}, output: "", success: false, error };
}

interface PageMeta {
  title?: string | undefined;
  url: string;
  published?: string | undefined;
  kind: string;
}

function extractMeta(contentType: string, url: string): PageMeta {
  const shortType = contentType.split(";")[0].trim() || "unknown";
  const kind = shortType.includes("pdf")
    ? "PDF document"
    : shortType.includes("html")
      ? "web page"
      : shortType;
  return { url, kind };
}

/**
 * Combine metadata header + extracted body into the final tool output.
 * The header gives the model stable facts (title, source URL) to cite.
 */
function formatOutput(meta: PageMeta, body: string, maxLength: number, note?: string): string {
  const lines: string[] = [];
  if (meta.title) lines.push(`Title: ${meta.title}`);
  lines.push(`Source: ${meta.url}`);
  lines.push(`Type: ${meta.kind}`);
  if (note) lines.push(`Note: ${note}`);
  lines.push("");

  const header = lines.join("\n");
  const room = Math.max(maxLength - header.length - 40, 200);

  if (!body.trim()) {
    return note ? header : `${header}\nNo readable text content was found at this link.`;
  }

  if (body.length <= room) {
    return `${header}\n${body}`;
  }
  return `${header}\n${body.slice(0, room)}\n\n[...truncated — original is ${body.length} characters]`;
}

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function decodeUtf8(buffer: ArrayBuffer): string {
  return new TextDecoder("utf-8").decode(buffer);
}

function looksLikeText(buffer: ArrayBuffer): boolean {
  const sample = new Uint8Array(buffer.slice(0, 512));
  let controlBytes = 0;
  for (const byte of sample) {
    if (byte === 0 || (byte < 9 && byte !== 0)) return false;
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) controlBytes++;
  }
  return controlBytes / Math.max(sample.length, 1) < 0.1;
}

// ── HTML ────────────────────────────────────────────────────────────────

/** Selectors that are page chrome rather than content. */
const JUNK_SELECTORS = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "iframe",
  "form",
  "button",
  "nav",
  "header",
  "footer",
  "aside",
  "dialog",
  "[role='navigation']",
  "[role='banner']",
  "[role='complementary']",
  "[role='contentinfo']",
  "[role='search']",
  "[role='dialog']",
  "[aria-hidden='true']",
  ".cookie",
  ".cookies",
  "#cookie-banner",
  "#cookie-notice",
  ".cookie-banner",
  ".newsletter",
  ".subscribe",
  ".signup",
  ".paywall",
  ".ad",
  ".ads",
  ".advert",
  ".advertisement",
  ".sponsor",
  ".social-share",
  ".share",
  ".sharing",
  ".related",
  ".comments",
  "#comments",
  ".sidebar",
  ".breadcrumb",
  ".breadcrumbs",
  ".promo",
  ".banner",
  ".popup",
  ".modal",
  ".tooltip",
  ".skip-link",
].join(",");

/** Preferred containers for article content, in priority order. */
const CONTENT_SELECTORS = [
  "article",
  "[itemprop='articleBody']",
  "[property='articleBody']",
  "main",
  "[role='main']",
  "#content",
  "#main-content",
  ".post-content",
  ".entry-content",
  ".article-content",
  ".article-body",
  ".post-body",
  ".markdown-body",
];

interface ExtractedPage {
  title?: string;
  published?: string;
  text: string;
}

/**
 * Extract the readable content of an HTML page as markdown-ish text.
 * Pure function on a string so it can be unit-tested without network.
 * Relative links are resolved against baseUrl.
 */
export function htmlToReadableText(html: string, baseUrl: string): ExtractedPage {
  const $ = cheerio.load(html);

  const title = extractTitle($);
  const published =
    $('meta[property="article:published_time"]').attr("content") ??
    $('meta[name="date"]').attr("content") ??
    $("time[datetime]").first().attr("datetime");

  $(JUNK_SELECTORS).remove();

  const root = pickContentRoot($);
  const text = serializeNode($, root, baseUrl);

  return {
    title,
    published,
    text: text.replace(/\n{3,}/g, "\n\n").trim(),
  };
}

/** Best-effort page title: og:title → twitter:title → <title> → first h1. */
export function extractTitle($: cheerio.CheerioAPI): string | undefined {
  const candidates = [
    $('meta[property="og:title"]').attr("content"),
    $('meta[name="twitter:title"]').attr("content"),
    $("title").first().text(),
    $("h1").first().text(),
  ];
  for (const c of candidates) {
    const t = c?.replace(/\s+/g, " ").trim();
    if (t) return t;
  }
  return undefined;
}

/**
 * Choose where the main content lives.
 * Known containers win immediately; otherwise fall back to density scoring
 * over large structural blocks, then to <body>.
 */
function pickContentRoot($: cheerio.CheerioAPI): cheerio.Cheerio<any> {
  for (const sel of CONTENT_SELECTORS) {
    const found = $(sel).first();
    if (found.length > 0 && textLength(found) > 120) {
      return found;
    }
  }

  // Density scoring across candidate blocks.
  let best: cheerio.Cheerio<any> | undefined;
  let bestScore = 0;
  $("div, section, td").each((_, el) => {
    const node = $(el);
    if (node.children().length === 0) return;
    const len = textLength(node);
    if (len < 200) return;
    // Prefer blocks whose text dominates their own markup (few links).
    const linkLen = node.find("a").text().length;
    const score = len + (len - linkLen);
    if (score > bestScore) {
      bestScore = score;
      best = node;
    }
  });

  return best ?? $("body");
}

function textLength(node: cheerio.Cheerio<any>): number {
  return node.text().replace(/\s+/g, " ").trim().length;
}

/**
 * Serialize a DOM subtree to markdown-ish text, preserving headings, lists,
 * links, quotes and code fences so the LLM sees real document structure.
 */
function serializeNode($: cheerio.CheerioAPI, node: cheerio.Cheerio<any>, baseUrl: string): string {
  const out: string[] = [];

  const walk = (el: any, depth: number): void => {
    const $el = $(el);
    switch (tagName(el)) {
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6": {
        const level = Number(tagName(el)[1]);
        pushHeading(out, inlineText($, $el, baseUrl), level);
        break;
      }
      case "p": {
        const text = inlineText($, $el, baseUrl);
        if (text) out.push(text, "");
        break;
      }
      case "blockquote": {
        const quoted = blockText($, $el)
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n");
        if (quoted.trim() !== ">") out.push(quoted, "");
        break;
      }
      case "pre": {
        const code = $el.text().replace(/\s+$/g, "");
        out.push("```", code, "```", "");
        break;
      }
      case "ul":
      case "ol": {
        emitList(out, $, $el, depth, baseUrl, tagName(el) === "ol");
        break;
      }
      case "table": {
        emitTable(out, $, $el);
        break;
      }
      case "hr": {
        out.push("---", "");
        break;
      }
      default: {
        if (hasElementChildren($el)) {
          $el.contents().each((_, child) => {
            if ((child as any).type === "text") {
              const t = $(child).text().replace(/\s+/g, " ").trim();
              if (t) out.push(t, "");
            } else {
              walk(child, depth);
            }
          });
        } else {
          const text = inlineText($, $el, baseUrl);
          if (text) out.push(text, "");
        }
      }
    }
  };

  node.each((_, el) => walk(el, 0));
  return out
    .join("\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function tagName(el: any): string {
  return (el.tagName ?? el.name ?? "").toString().toLowerCase();
}

function hasElementChildren($el: cheerio.Cheerio<any>): boolean {
  return $el
    .contents()
    .toArray()
    .some((c) => (c as any).type === "tag");
}

function pushHeading(out: string[], text: string, level: number): void {
  if (!text) return;
  out.push(`${"#".repeat(level)} ${text}`, "");
}

/** Inline text with links/bold/italics preserved as markdown. */
function inlineText($: cheerio.CheerioAPI, $el: cheerio.Cheerio<any>, baseUrl: string): string {
  const clone = $el.clone();
  clone.find(JUNK_SELECTORS).remove();

  clone.find("a[href]").each((_, a) => {
    const href = absoluteUrl($(a).attr("href"), baseUrl);
    const label = $(a).text().replace(/\s+/g, " ").trim();
    const replacement = label ? (href ? `[${label}](${href})` : label) : "";
    $(a).replaceWith(replacement);
  });

  clone.find("strong, b").replaceWith((_, inner) => `**${$(inner).text().trim()}**`);
  clone.find("em, i").replaceWith((_, inner) => `*${$(inner).text().trim()}*`);
  clone.find("br").replaceWith("\n");

  return clone
    .text()
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

/** Full block text used for quotes (structure inside doesn't matter much). */
function blockText($: cheerio.CheerioAPI, $el: cheerio.Cheerio<any>): string {
  return $el
    .text()
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function emitList(
  out: string[],
  $: cheerio.CheerioAPI,
  list: cheerio.Cheerio<any>,
  depth: number,
  baseUrl: string,
  ordered: boolean,
): void {
  let index = 1;
  list.children("li").each((_, li) => {
    const marker = ordered ? `${index++}.` : "-";
    const itemText = inlineText($, $(li).clone().children("ul, ol").remove().end(), baseUrl);
    if (itemText) out.push(`${"  ".repeat(depth)}${marker} ${itemText}`);

    // Nested lists recurse with extra indent.
    $(li)
      .children("ul, ol")
      .each((_, nested) => {
        emitList(out, $, $(nested), depth + 1, baseUrl, tagName(nested) === "ol");
      });
  });
  out.push("");
}

/** Render tables as pipe-delimited rows — compact and model-friendly. */
function emitTable(out: string[], $: cheerio.CheerioAPI, table: cheerio.Cheerio<any>): void {
  table.find("tr").each((_, tr) => {
    const cells = $(tr)
      .find("th, td")
      .map((__, cell) => $(cell).text().replace(/\s+/g, " ").trim())
      .get();
    if (cells.some(Boolean)) out.push(`| ${cells.join(" | ")} |`);
  });
  out.push("");
}

function absoluteUrl(href: string | undefined, baseUrl: string): string | undefined {
  if (!href) return undefined;
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return undefined; // skip unresolvable links rather than emit junk
  }
}

// ── PDF ────────────────────────────────────────────────────────────────

async function extractPdfText(buffer: ArrayBuffer): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(pdf, { mergePages: true });
  return Array.isArray(text) ? text.join("\n\n") : String(text ?? "");
}
