import type { Logger } from "../config/logger.js";
import type { Tool, ToolResult } from "./types.js";
import { getEnv } from "../config/env.js";

/**
 * Web search tool using Tavily (primary) with DuckDuckGo fallback.
 */
export function createWebSearchTool(logger: Logger): Tool {
  const log = logger.child({ component: "WebSearchTool" });

  return {
    definition: {
      name: "web_search",
      description: "Search the web for up-to-date information. Use this to find current news, data, or facts.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query",
          },
          count: {
            type: "number",
            description: "Number of results to return (1-10, default 5)",
            default: 5,
          },
        },
        required: ["query"],
      },
    },

    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const query = String(args.query ?? "");
      const count = Math.min(Math.max(Number(args.count) || 5, 1), 10);

      if (!query) {
        return { toolName: "web_search", args, output: "", success: false, error: "Query is required" };
      }

      const env = getEnv();
      const provider = env.WEB_SEARCH_PROVIDER;

      if (provider === "tavily" && env.TAVILY_API_KEY) {
        return searchTavily(query, count, log);
      }

      if (provider === "talordata" && env.TALORDATA_API_KEY) {
        return searchTalorData(query, count, log);
      }

      // Fallback: scrape-based search
      return searchViaScrape(query, count, log);
    },
  };
}

async function searchTavily(query: string, count: number, log: Logger): Promise<ToolResult> {
  try {
    const env = getEnv();
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: env.TAVILY_API_KEY,
        query,
        max_results: count,
        include_answer: true,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      log.error({ status: response.status, body: text }, "Tavily search failed");
      // Fallback to scrape
      return searchViaScrape(query, count, log);
    }

    const data = (await response.json()) as {
      answer?: string;
      results?: Array<{ title: string; url: string; content: string }>;
    };

    const parts: string[] = [];
    if (data.answer) {
      parts.push(`Summary: ${data.answer}`);
    }
    if (data.results) {
      for (const r of data.results) {
        parts.push(`\n---\nTitle: ${r.title}\nURL: ${r.url}\n${r.content.slice(0, 1000)}`);
      }
    }

    return {
      toolName: "web_search",
      args: { query, count },
      output: parts.join("\n") || "No results found.",
      success: true,
    };
  } catch (err) {
    log.error({ err }, "Tavily search error, falling back to scrape");
    return searchViaScrape(query, count, log);
  }
}

/**
 * Search via TalorData SERP API.
 * Uses the Bearer token auth and form-urlencoded POST format.
 */
async function searchTalorData(query: string, count: number, log: Logger): Promise<ToolResult> {
  try {
    const env = getEnv();
    const response = await fetch("https://serpapi.talordata.net/serp/v1/request", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Bearer ${env.TALORDATA_API_KEY}`,
      },
      body: new URLSearchParams({
        engine: "google",
        q: query,
        json: "1",
        num: String(Math.min(count, 10)),
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      log.error({ status: response.status, body: text }, "TalorData search failed");
      return searchViaScrape(query, count, log);
    }

    const data = (await response.json()) as {
      organic?: Array<{ title: string; link: string; snippet: string }>;
      answer_box?: { answer?: string; snippet?: string; title?: string; link?: string };
      knowledge_graph?: { title?: string; description?: string };
    };

    const parts: string[] = [];

    // Answer box (featured snippet)
    if (data.answer_box) {
      const ab = data.answer_box;
      parts.push(`Featured Answer:`);
      if (ab.title) parts.push(`  Title: ${ab.title}`);
      if (ab.answer) parts.push(`  Answer: ${ab.answer}`);
      if (ab.snippet) parts.push(`  Snippet: ${ab.snippet}`);
      if (ab.link) parts.push(`  Link: ${ab.link}`);
    }

    // Knowledge graph
    if (data.knowledge_graph) {
      const kg = data.knowledge_graph;
      parts.push(`\nKnowledge Graph:`);
      if (kg.title) parts.push(`  Title: ${kg.title}`);
      if (kg.description) parts.push(`  Description: ${kg.description}`);
    }

    // Organic results
    if (data.organic && data.organic.length > 0) {
      for (const r of data.organic.slice(0, count)) {
        parts.push(`\n---\nTitle: ${r.title}\nURL: ${r.link}\n${r.snippet?.slice(0, 1000) ?? ""}`);
      }
    }

    if (parts.length === 0) {
      return {
        toolName: "web_search",
        args: { query, count },
        output: "No results found.",
        success: true,
      };
    }

    return {
      toolName: "web_search",
      args: { query, count },
      output: parts.join("\n"),
      success: true,
    };
  } catch (err) {
    log.error({ err }, "TalorData search error, falling back to scrape");
    return searchViaScrape(query, count, log);
  }
}

/**
 * Fallback search via DuckDuckGo's HTML scraper.
 * Uses duckduckgo's lite endpoint for minimal parsing.
 */
async function searchViaScrape(query: string, count: number, log: Logger): Promise<ToolResult> {
  try {
    const encoded = encodeURIComponent(query);
    const url = `https://lite.duckduckgo.com/lite/?q=${encoded}`;

    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; BoopAgent/1.0)",
      },
    });

    if (!response.ok) {
      return {
        toolName: "web_search",
        args: { query, count },
        output: "",
        success: false,
        error: `DuckDuckGo returned status ${response.status}`,
      };
    }

    const html = await response.text();

    // Simple extraction from DuckDuckGo lite HTML
    const results: Array<{ title: string; snippet: string; url: string }> = [];
    const linkRegex = /<a[^>]+href="([^"]*)"[^>]*class="result-link"[^>]*>([\s\S]*?)<\/a>/g;
    const snippetRegex = /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/g;

    let linkMatch: RegExpExecArray | null;
    let snippetMatch: RegExpExecArray | null;
    const links: string[] = [];
    const snippets: string[] = [];

    while ((linkMatch = linkRegex.exec(html)) !== null) {
      const title = linkMatch[2].replace(/<[^>]+>/g, "").trim();
      const url = linkMatch[1].startsWith("http") ? linkMatch[1] : `https://duckduckgo.com${linkMatch[1]}`;
      links.push(title || url);
    }

    while ((snippetMatch = snippetRegex.exec(html)) !== null) {
      snippets.push(snippetMatch[1].replace(/<[^>]+>/g, "").trim());
    }

    for (let i = 0; i < Math.min(links.length, count); i++) {
      results.push({
        title: links[i] || `Result ${i + 1}`,
        snippet: snippets[i] || "",
        url: "",
      });
    }

    // Alternative simpler parsing for lite mode
    if (results.length === 0) {
      // DuckDuckGo lite table-based layout
      const rows = html.split("</tr>");
      for (const row of rows) {
        const titleMatch = row.match(/class="result-link"[^>]*>([\s\S]*?)<\/a>/);
        const snippetMatch = row.match(/class="result-snippet"[^>]*>([\s\S]*?)<\/td>/);
        if (titleMatch) {
          results.push({
            title: titleMatch[1].replace(/<[^>]+>/g, "").trim(),
            snippet: snippetMatch?.[1]?.replace(/<[^>]+>/g, "").trim() ?? "",
            url: "",
          });
        }
      }
    }

    if (results.length === 0) {
      return {
        toolName: "web_search",
        args: { query, count },
        output: "No results found.",
        success: true,
      };
    }

    const output = results
      .slice(0, count)
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet}`)
      .join("\n\n");

    return {
      toolName: "web_search",
      args: { query, count },
      output,
      success: true,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "DuckDuckGo search error");
    return {
      toolName: "web_search",
      args: { query, count },
      output: "",
      success: false,
      error: `Search failed: ${message}`,
    };
  }
}
