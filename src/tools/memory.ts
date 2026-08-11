import type { Logger } from "../config/logger.js";
import type { MemoryStore } from "../agent/memory.js";
import type { Tool, ToolResult } from "./types.js";

/**
 * Create read/write memory tools backed by the given MemoryStore.
 */
export function createMemoryTools(memory: MemoryStore, logger: Logger): Tool[] {
  const log = logger.child({ component: "MemoryTools" });

  const recallTool: Tool = {
    definition: {
      name: "recall",
      description:
        "Recall stored memories. Use this to retrieve information you previously saved about the user or conversation.",
      inputSchema: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description: "The memory key to look up (optional — omit to list all)",
          },
          category: {
            type: "string",
            description: "Filter by category (optional, only used when key is omitted)",
          },
        },
      },
    },

    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      try {
        const key = args.key as string | undefined;
        const category = args.category as string | undefined;

        if (key) {
          const entry = await memory.get(key);
          if (!entry) {
            return {
              toolName: "recall",
              args,
              output: `No memory found for key "${key}".`,
              success: true,
            };
          }
          return {
            toolName: "recall",
            args,
            output: `[${entry.key}] (${entry.category ?? "general"})\n${entry.content}\n(Last updated: ${new Date(entry.updatedAt).toISOString()})`,
            success: true,
          };
        }

        const entries = await memory.list(category);
        if (entries.length === 0) {
          return {
            toolName: "recall",
            args,
            output: "No memories stored yet.",
            success: true,
          };
        }

        const formatted = entries
          .map(
            (e) => `- ${e.key}${e.category ? ` [${e.category}]` : ""}: ${e.content.slice(0, 200)}`,
          )
          .join("\n");

        return {
          toolName: "recall",
          args,
          output: `Memories:\n${formatted}`,
          success: true,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ error: message }, "Recall failed");
        return { toolName: "recall", args, output: "", success: false, error: message };
      }
    },
  };

  const writeMemoryTool: Tool = {
    definition: {
      name: "write_memory",
      description:
        "Store a memory. Use this to remember important information about the user, their preferences, or conversation context for future reference.",
      inputSchema: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description: "A unique key for this memory (e.g., 'user_name', 'preferred_model')",
          },
          content: {
            type: "string",
            description: "The memory content to store",
          },
          category: {
            type: "string",
            description: "Optional category for grouping (e.g., 'user_prefs', 'project', 'fact')",
            default: "general",
          },
        },
        required: ["key", "content"],
      },
    },

    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      try {
        const key = String(args.key ?? "");
        const content = String(args.content ?? "");
        const category = (args.category as string) || "general";

        if (!key || !content) {
          return {
            toolName: "write_memory",
            args,
            output: "",
            success: false,
            error: "Both 'key' and 'content' are required",
          };
        }

        await memory.set(key, content, category);
        log.debug({ key, category }, "Memory written");

        return {
          toolName: "write_memory",
          args,
          output: `Memory "${key}" saved.`,
          success: true,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ error: message }, "Write memory failed");
        return { toolName: "write_memory", args, output: "", success: false, error: message };
      }
    },
  };

  return [recallTool, writeMemoryTool];
}
