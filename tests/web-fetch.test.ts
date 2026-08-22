import * as cheerio from "cheerio";
import { describe, expect, it } from "vitest";
import {
  blockedHostReason,
  extractFromBuffer,
  extractTitle,
  formatMailto,
  htmlToReadableText,
  selectAuthHeaders,
} from "../src/tools/web-fetch.js";
import { extractYouTubeId } from "../src/tools/youtube.js";

const ARTICLE_HTML = `<!doctype html>
<html>
<head>
  <title>Old title tag</title>
  <meta property="og:title" content="How Cocoa Is Priced" />
  <meta property="article:published_time" content="2026-08-01T09:00:00Z" />
</head>
<body>
  <nav><a href="/">Home</a> <a href="/about">About</a></nav>
  <div class="cookie-banner">We use cookies</div>
  <article>
    <h1>How Cocoa Is Priced</h1>
    <p>Ghana supplies roughly <strong>60%</strong> of the world's cocoa. See the <a href="/data/chart">full chart</a>.</p>
    <ul>
      <li>Farmgate price set seasonally</li>
      <li>World price floats on ICE futures</li>
    </ul>
    <blockquote>The spread is the story.</blockquote>
    <h2>Outlook</h2>
    <p>Analysts expect tighter supply through Q1.</p>
  </article>
  <footer>© 2026 Nobody Inc.</footer>
</body>
</html>`;

describe("extractTitle", () => {
  it("prefers og:title over the <title> tag", () => {
    expect(extractTitle(cheerio.load(ARTICLE_HTML))).toBe("How Cocoa Is Priced");
  });

  it("falls back to the <title> tag", () => {
    expect(extractTitle(cheerio.load("<html><head><title>Fallback</title></head></html>"))).toBe(
      "Fallback",
    );
  });

  it("returns undefined for a page with no title signals", () => {
    expect(extractTitle(cheerio.load("<html><body></body></html>"))).toBeUndefined();
  });
});

describe("htmlToReadableText", () => {
  const page = htmlToReadableText(ARTICLE_HTML, "https://example.com/posts/cocoa");

  it("extracts og:title and published time", () => {
    expect(page.title).toBe("How Cocoa Is Priced");
    expect(page.published).toBe("2026-08-01T09:00:00Z");
  });

  it("keeps article content", () => {
    expect(page.text).toContain("# How Cocoa Is Priced");
    expect(page.text).toContain("60%");
    expect(page.text).toContain("## Outlook");
    expect(page.text).toContain("Analysts expect tighter supply through Q1.");
  });

  it("drops nav, footer, and cookie chrome", () => {
    expect(page.text).not.toContain("We use cookies");
    expect(page.text).not.toContain("Nobody Inc.");
    expect(page.text).not.toContain("/about");
  });

  it("preserves list structure", () => {
    expect(page.text).toMatch(/- Farmgate price set seasonally/);
    expect(page.text).toMatch(/- World price floats on ICE futures/);
  });

  it("preserves quotes and inline links as markdown", () => {
    expect(page.text).toContain("> The spread is the story.");
    expect(page.text).toContain("[full chart](https://example.com/data/chart)");
  });

  it("falls back to density scoring when there is no semantic container", () => {
    const bare = htmlToReadableText(
      `<html><body>
        <div class="chrome">menu menu menu</div>
        <div id="wrapper">
          <div class="inner"><p>${"Real analysis content. ".repeat(20)}</p></div>
        </div>
      </body></html>`,
      "https://example.com/x",
    );
    expect(bare.text).toContain("Real analysis content.");
    expect(bare.text).not.toContain("menu menu menu");
  });
});

describe("extractYouTubeId", () => {
  const cases: Array<[string, string | null]> = [
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://youtube.com/watch?v=dQw4w9WgXcQ&t=90s", "dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ?t=30", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/shorts/abc123XYZ_-", "abc123XYZ_-"],
    ["https://www.youtube.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/live/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://m.youtube.com/watch?v=dQw4w9WgXcQ&pp=xyz", "dQw4w9WgXcQ"],
    ["https://example.com/watch?v=dQw4w9WgXcQ", null],
    ["https://www.youtube.com/playlist?list=PL123", null],
    ["https://en.wikipedia.org/wiki/Ghana", null],
  ];

  it.each(cases)("parses %s → %s", (input, expected) => {
    expect(extractYouTubeId(input)).toBe(expected);
  });
});

describe("formatMailto", () => {
  it("describes recipient and subject", () => {
    const out = formatMailto(new URL("mailto:ada@example.com?subject=Hello%20there"));
    expect(out).toContain("Type: email compose link");
    expect(out).toContain("To: ada@example.com");
    expect(out).toContain("Subject: Hello there");
    expect(out).not.toContain("Pre-filled body");
  });

  it("handles cc, bcc, multiple recipients and a body", () => {
    const out = formatMailto(
      new URL("mailto:a@x.com,b@x.com?cc=c@x.com&bcc=secret@x.com&body=Line%201%0ALine%202"),
    );
    expect(out).toContain("To: a@x.com, b@x.com");
    expect(out).toContain("Cc: c@x.com");
    expect(out).toContain("Bcc: secret@x.com");
    expect(out).toContain("Line 1\nLine 2");
  });

  it("survives a bare recipient with no query params", () => {
    const out = formatMailto(new URL("mailto:solo@example.org"));
    expect(out).toContain("To: solo@example.org");
    expect(out).not.toContain("Subject:");
  });
});

describe("blockedHostReason", () => {
  it("blocks loopback, RFC1918, link-local and CGNAT literals", () => {
    for (const host of [
      "127.0.0.1",
      "10.1.2.3",
      "192.168.1.50",
      "172.16.0.1",
      "172.31.255.255",
      "169.254.169.254",
      "100.100.1.1",
      "0.0.0.0",
      "::1",
      "[::ffff:127.0.0.1]",
      "[fd12::1]",
      "[fe80::1]",
      "localhost",
      "db.internal",
      "nas.home.arpa",
    ]) {
      expect(blockedHostReason(host), `expected ${host} to be blocked`).toBeDefined();
    }
  });

  it("allows public hosts and near-miss ranges", () => {
    for (const host of [
      "example.com",
      "172.32.0.1",
      "100.200.1.1",
      "render.com",
      "[2606:4700::1111]",
    ]) {
      expect(blockedHostReason(host), `expected ${host} to be allowed`).toBeUndefined();
    }
  });
});

describe("selectAuthHeaders", () => {
  const config = {
    "github.com": { Authorization: "Bearer ghp_abc" },
    "news.example.com": { Cookie: "session=xyz" },
    "example.com": { "X-Tier": "basic" },
  };

  it("matches exact domains", () => {
    expect(selectAuthHeaders(config, "github.com")).toEqual({ Authorization: "Bearer ghp_abc" });
  });

  it("covers subdomains of the configured domain", () => {
    expect(selectAuthHeaders(config, "api.github.com")).toEqual({
      Authorization: "Bearer ghp_abc",
    });
  });

  it("prefers the longest matching domain key", () => {
    expect(selectAuthHeaders(config, "news.example.com")).toEqual({ Cookie: "session=xyz" });
    expect(selectAuthHeaders(config, "other.example.com")).toEqual({ "X-Tier": "basic" });
  });

  it("returns nothing for unrelated hosts or malformed config", () => {
    expect(selectAuthHeaders(config, "unrelated.org")).toEqual({});
    expect(selectAuthHeaders(null, "github.com")).toEqual({});
    expect(selectAuthHeaders("nope", "github.com")).toEqual({});
  });
});

describe("extractFromBuffer", () => {
  it("passes text buffers through by sniffing when no content-type is given", async () => {
    const buf = new TextEncoder().encode("# Notes\n\nplain markdown body").buffer;
    const out = await extractFromBuffer(buf, { filename: "notes.md" });
    expect(out.kind).toBe("md file");
    expect(out.body).toContain("plain markdown body");
  });

  it("pretty-prints JSON payloads", async () => {
    const buf = new TextEncoder().encode('{"a":1,"b":[2,3]}').buffer;
    const out = await extractFromBuffer(buf, { contentType: "application/json" });
    expect(out.kind).toBe("JSON data");
    expect(JSON.parse(out.body)).toEqual({ a: 1, b: [2, 3] });
  });

  it("reports binary media honestly instead of mangling it", async () => {
    const buf = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00]).buffer;
    const out = await extractFromBuffer(buf, { contentType: "image/png" });
    expect(out.note).toContain("binary media");
    expect(out.body).toBe("");
  });
});
