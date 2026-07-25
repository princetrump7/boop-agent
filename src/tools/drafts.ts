import type { Logger } from "../config/logger.js";
import type { Tool, ToolResult } from "./types.js";

/**
 * Describes a draft that has been saved.
 */
export interface DraftEntry {
  id: string;
  title: string;
  content: string;
  status: "draft" | "pending_approval" | "approved" | "rejected";
  chatId: number;
  turnId?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Simple in-memory draft store.
 * When Convex is available, the agent runtime will use the Convex draft tables instead.
 */
const draftStore = new Map<string, DraftEntry>();

let draftCounter = 0;

/**
 * Create draft-related tools for saving and managing agent drafts.
 */
export function createDraftTools(logger: Logger): Tool[] {
  const log = logger.child({ component: "DraftTools" });

  const saveDraftTool: Tool = {
    definition: {
      name: "save_draft",
      description: "Save a draft of your current work (code, content, analysis) that can be reviewed later.",
      inputSchema: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "A descriptive title for the draft",
          },
          content: {
            type: "string",
            description: "The draft content",
          },
          type: {
            type: "string",
            description: "Type of draft (e.g., 'code', 'analysis', 'content')",
            default: "content",
          },
        },
        required: ["title", "content"],
      },
    },

    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      try {
        const title = String(args.title ?? "");
        const content = String(args.content ?? "");

        if (!title || !content) {
          return {
            toolName: "save_draft",
            args,
            output: "",
            success: false,
            error: "Both 'title' and 'content' are required",
          };
        }

        draftCounter++;
        const id = `draft_${draftCounter}_${Date.now()}`;
        const now = Date.now();

        const draft: DraftEntry = {
          id,
          title,
          content,
          status: "draft",
          chatId: 0,
          createdAt: now,
          updatedAt: now,
        };

        draftStore.set(id, draft);
        log.debug({ id, title }, "Draft saved");

        return {
          toolName: "save_draft",
          args,
          output: `Draft saved with ID: ${id}\nTitle: ${title}\nUse list_drafts to view all drafts.`,
          success: true,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { toolName: "save_draft", args, output: "", success: false, error: message };
      }
    },
  };

  const listDraftsTool: Tool = {
    definition: {
      name: "list_drafts",
      description: "List all saved drafts.",
      inputSchema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            description: "Filter by status (draft, pending_approval, approved, rejected)",
            enum: ["draft", "pending_approval", "approved", "rejected"],
          },
        },
      },
    },

    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      try {
        const statusFilter = args.status as string | undefined;
        const entries = Array.from(draftStore.values());

        const filtered = statusFilter
          ? entries.filter((d) => d.status === statusFilter)
          : entries;

        if (filtered.length === 0) {
          return {
            toolName: "list_drafts",
            args,
            output: "No drafts found.",
            success: true,
          };
        }

        const formatted = filtered
          .map((d) => `- [${d.id}] ${d.title} (${d.status})`)
          .join("\n");

        return {
          toolName: "list_drafts",
          args,
          output: `Drafts (${filtered.length}):\n${formatted}`,
          success: true,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { toolName: "list_drafts", args, output: "", success: false, error: message };
      }
    },
  };

  return [saveDraftTool, listDraftsTool];
}
