import type { Logger } from "../config/logger.js";
import type { Tool, ToolResult } from "./types.js";

/**
 * Web fetch tool — fetches a URL and returns its content as plain text.
 * Strips HTML tags for readability.
 */
export function createWebFetchTool(logger: Logger): Tool {
  const log = logger.child({ component: "WebFetchTool" });

  return {
    definition: {
      name: "web_fetch",
      description: "Fetch the contents of a URL. Returns plain text content stripped of HTML.",
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The URL to fetch",
          },
          maxLength: {
            type: "number",
            description: "Maximum characters to return (default 8000)",
            default: 8000,
          },
        },
        required: ["url"],
      },
    },

    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const url = String(args.url ?? "");
      const maxLength = Math.min(Math.max(Number(args.maxLength) || 8000, 100), 50000);

      if (!url) {
        return { toolName: "web_fetch", args, output: "", success: false, error: "URL is required" };
      }

      try {
        log.debug({ url }, "Fetching URL");

        const response = await fetch(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; BoopAgent/1.0)",
            Accept: "text/html,text/plain,*/*",
          },
          signal: AbortSignal.timeout(15000),
        });

        if (!response.ok) {
          return {
            toolName: "web_fetch",
            args,
            output: "",
            success: false,
            error: `HTTP ${response.status}: ${response.statusText}`,
          };
        }

        const contentType = response.headers.get("content-type") || "";
        let text: string;

        if (contentType.includes("application/json")) {
          text = JSON.stringify(await response.json(), null, 2);
        } else {
          text = await response.text();
          text = stripHtml(text);
        }

        // Truncate
        if (text.length > maxLength) {
          text = text.slice(0, maxLength) + `\n\n... [truncated from ${text.length} characters]`;
        }

        return {
          toolName: "web_fetch",
          args,
          output: text,
          success: true,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ url, error: message }, "Web fetch failed");
        return {
          toolName: "web_fetch",
          args,
          output: "",
          success: false,
          error: `Failed to fetch URL: ${message}`,
        };
      }
    },
  };
}

/**
 * Strip HTML tags and return plain text content.
 */
function stripHtml(html: string): string {
  return html
    // Remove scripts
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    // Remove styles
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    // Remove HTML tags
    .replace(/<[^>]+>/g, " ")
    // Decode common entities
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    // Collapse whitespace
    .replace(/\s+/g, " ")
    .replace(/\n\s*\n/g, "\n")
    .trim();
}
