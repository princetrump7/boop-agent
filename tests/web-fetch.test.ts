import * as cheerio from "cheerio";
import { describe, expect, it } from "vitest";
import { extractTitle, htmlToReadableText } from "../src/tools/web-fetch.js";
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
