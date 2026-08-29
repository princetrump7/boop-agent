import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  normalizeUrl,
  extractLinks,
  shouldFollowLink,
  detectPaywall,
  createWebCrawlTool,
} from "../src/tools/web-crawl.js";
import type { Logger } from "../src/config/logger.js";

function stubLogger(): Logger {
  return {
    // biome-ignore lint/suspicious/noEmptyBlockStatements: test stub
    child: () => stubLogger(),
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as unknown as Logger;
}

describe("normalizeUrl", () => {
  it("strips hash fragments for dedup", () => {
    expect(normalizeUrl("https://example.com/page#section")).toBe(
      "https://example.com/page",
    );
  });

  it("lowercases hostname while keeping path case-sensitive", () => {
    expect(normalizeUrl("https://Example.COM/Path")).toBe("https://example.com/Path");
  });

  it("collapses default ports", () => {
    expect(normalizeUrl("https://example.com:443/a")).toBe("https://example.com/a");
    expect(normalizeUrl("http://example.com:80/b")).toBe("http://example.com/b");
    // non-default port kept
    expect(normalizeUrl("http://example.com:8080/c")).toBe("http://example.com:8080/c");
  });

  it("returns raw string for unparseable inputs", () => {
    expect(normalizeUrl("not a url")).toBe("not a url");
  });
});

describe("extractLinks", () => {
  it("resolves relative links against the base and dedups", () => {
    const html = `
      <a href="/about">About</a>
      <a href="/about">About dup</a>
      <a href="https://external.com/x">Ext</a>
      <a href="#frag">skip</a>
      <a href="javascript:void(0)">skip</a>
      <a href="mailto:a@b.com">skip</a>
    `;
    const links = extractLinks(html, "https://example.com/blog/post");
    expect(links).toContain("https://example.com/about");
    expect(links).toContain("https://external.com/x");
    expect(links.filter((l) => l === "https://example.com/about")).toHaveLength(1);
    expect(links).not.toContain("mailto:a@b.com");
    expect(links.length).toBe(2);
  });

  it("resolves protocol-relative and absolute paths", () => {
    const html = `<a href="../up">Up</a><a href="//cdn.example.com/asset">CDN</a>`;
    const links = extractLinks(html, "https://example.com/a/b/");
    expect(links).toContain("https://example.com/a/up");
    expect(links).toContain("https://cdn.example.com/asset");
  });

  it("skips non-http(s) protocols after resolution", () => {
    const html = `<a href="blob:https://example.com/uuid">blob</a>`;
    expect(extractLinks(html, "https://example.com/")).toEqual([]);
  });
});

describe("shouldFollowLink", () => {
  it("rejects off-host when sameDomain is true", () => {
    const seen = new Set<string>();
    expect(shouldFollowLink("https://example.com/page", "example.com", true, seen)).toBe(true);
    expect(shouldFollowLink("https://other.com/page", "example.com", true, seen)).toBe(false);
  });

  it("allows cross-host when sameDomain is false", () => {
    const seen = new Set<string>();
    expect(shouldFollowLink("https://other.com/page", "example.com", false, seen)).toBe(true);
  });

  it("rejects already-seen normalized URLs", () => {
    const seen = new Set([normalizeUrl("https://example.com/page")]);
    expect(shouldFollowLink("https://example.com/page", "example.com", true, seen)).toBe(false);
    // hash variant counts as seen
    expect(shouldFollowLink("https://example.com/page#x", "example.com", true, seen)).toBe(false);
  });

  it("rejects private/internal hosts via SSRF guard", () => {
    const seen = new Set<string>();
    expect(shouldFollowLink("http://192.168.1.1/admin", "example.com", false, seen)).toBe(false);
    expect(shouldFollowLink("http://localhost/secret", "example.com", false, seen)).toBe(false);
  });
});

describe("detectPaywall", () => {
  it("flags class/id markers and subscription hints", () => {
    expect(detectPaywall('<div class="paywall">subscribe to read</div>')).toBe(true);
    expect(detectPaywall('<div id="paywall-gate"></div>')).toBe(true);
    expect(detectPaywall("This post is for paid subscribers only")).toBe(true);
    expect(detectPaywall("available for paid subscribers")).toBe(true);
    expect(detectPaywall("Subscribe to read the full article")).toBe(true);
  });

  it("returns false for ordinary article html", () => {
    expect(detectPaywall("<article><p>Hello world — free content</p></article>")).toBe(false);
  });
});

describe("createWebCrawlTool integration (mocked fetch)", () => {
  let origFetch: typeof globalThis.fetch;

  beforeEach(() => {
    origFetch = globalThis.fetch;
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("crawls a tiny two-page same-host site via BFS", async () => {
    const pages: Record<string, string> = {
      "https://example.com/": `<html><head><title>Home</title></head><body>
        <article><h1>Home</h1><p>Welcome.</p></article>
        <a href="/about">About</a>
        <a href="https://external.com/x">External</a>
      </body></html>`,
      "https://example.com/about": `<html><head><title>About us</title></head><body>
        <article><h1>About</h1><p>We build things.</p></article>
        <a href="/">back</a>
      </body></html>`,
    };

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const html = pages[url];
      if (!html) return new Response("Not found", { status: 404, headers: { "content-type": "text/html" } });
      return new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        // Response.url will be set to `url` automatically in some runtimes; mock via property override
      } as ResponseInit & { url?: string });
    }) as unknown as typeof fetch;

    // Make Response.url reflect the request url for our mock — fetch polyfill may not set it.
    // Monkey via overriding the Response prototype getter is unnecessary if we let the tool use the requested url as finalUrl when res.url empty.
    // Instead wrap fetch to return an object with `url` field.
    const tool = createWebCrawlTool(stubLogger());
    const result = await tool.execute({
      url: "https://example.com/",
      maxPages: 5,
      maxDepth: 1,
      sameDomain: true,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("Crawled 2 page(s)");
    expect(result.output).toContain("Home");
    expect(result.output).toContain("About us");
    expect(result.output).toContain("## 1.");
    expect(result.output).toContain("## 2.");
    expect(result.output).toContain("Sources");
    // external link should not be crawled (sameDomain=true)
    expect(result.output).not.toContain("external.com/x");
  });

  it("returns an honest no-pages message when every fetch fails", async () => {
    globalThis.fetch = vi.fn(async () => new Response("Not found", { status: 404, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    const tool = createWebCrawlTool(stubLogger());
    const result = await tool.execute({ url: "https://example.com/missing", maxPages: 3, maxDepth: 1 });
    expect(result.success).toBe(true);
    expect(result.output).toContain("produced no readable pages");
    expect(result.output).toContain("Failures");
  });

  it("rejects non-http(s) inputs early without fetching", async () => {
    const spy = vi.fn(async () => new Response("", { status: 200 }));
    globalThis.fetch = spy as unknown as typeof fetch;
    const tool = createWebCrawlTool(stubLogger());
    const r1 = await tool.execute({ url: "mailto:hi@example.com" });
    const r2 = await tool.execute({ url: "file:///etc/passwd" });
    const r3 = await tool.execute({ url: "http://localhost/admin" });
    expect(r1.success).toBe(false);
    expect(r2.success).toBe(false);
    expect(r3.success).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});
