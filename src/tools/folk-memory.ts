import type { Logger } from "../config/logger.js";
import type { Tool } from "./types.js";
import type { MemoryGraph } from "../folk/memory-graph.js";
import type { MemoryNodeKind } from "../folk/types.js";

const KINDS: MemoryNodeKind[] = ["person", "preference", "routine", "goal", "contact", "fact"];

/** folk memory-graph tools — persistent nodes + edges the agent grows every chat. */
export function createFolkMemoryTools(graph: MemoryGraph, logger: Logger): Tool[] {
  const log = logger.child({ component: "FolkMemoryTools" });

  const remember: Tool = {
    definition: {
      name: "memory_remember",
      description:
        "Remember something about the user in the persistent memory graph: people, preferences, routines, goals, contacts, facts. Grows across conversations.",
      inputSchema: {
        type: "object",
        properties: {
          chatId: { type: "string" },
          kind: { type: "string", enum: KINDS },
          label: { type: "string", description: "Short label, e.g. 'gym time', 'Ama', 'exam date'" },
          detail: { type: "string" },
          importance: { type: "number", minimum: 0, maximum: 1, default: 0.5 },
        },
        required: ["chatId", "kind", "label", "detail"],
      },
    },
    async execute(args) {
      try {
        const kind = KINDS.includes(args.kind as MemoryNodeKind) ? (args.kind as MemoryNodeKind) : "fact";
        const n = graph.remember({
          chatId: String(args.chatId),
          kind,
          label: String(args.label),
          detail: String(args.detail),
          importance: typeof args.importance === "number" ? args.importance : 0.5,
        });
        return { toolName: "memory_remember", args, output: `Remembered [${n.kind}] ${n.label}.`, success: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ error: message }, "memory_remember failed");
        return { toolName: "memory_remember", args, output: "", success: false, error: message };
      }
    },
  };

  const recall: Tool = {
    definition: {
      name: "memory_graph_recall",
      description: "Search the persistent memory graph for anything about the user.",
      inputSchema: {
        type: "object",
        properties: {
          chatId: { type: "string" },
          query: { type: "string" },
        },
        required: ["chatId", "query"],
      },
    },
    async execute(args) {
      const hits = graph.search(String(args.chatId), String(args.query ?? ""));
      if (hits.length === 0) return { toolName: "memory_graph_recall", args, output: "Nothing remembered yet.", success: true };
      return {
        toolName: "memory_graph_recall", args, success: true,
        output: hits.map((n) => `- [${n.kind}] ${n.label}: ${n.detail}`).join("\n"),
      };
    },
  };

  const link: Tool = {
    definition: {
      name: "memory_link",
      description: "Link two memories, e.g. link 'Ama' to 'gym buddy' with relation 'trains with'.",
      inputSchema: {
        type: "object",
        properties: {
          chatId: { type: "string" },
          from: { type: "string" },
          to: { type: "string" },
          relation: { type: "string" },
        },
        required: ["chatId", "from", "to", "relation"],
      },
    },
    async execute(args) {
      const e = graph.link(String(args.chatId), String(args.from), String(args.to), String(args.relation));
      if (!e) return { toolName: "memory_link", args, output: "", success: false, error: "One of the memories was not found — remember it first." };
      return { toolName: "memory_link", args, output: `Linked ${args.from} —[${args.relation}]→ ${args.to}.`, success: true };
    },
  };

  const forget: Tool = {
    definition: {
      name: "memory_forget",
      description: "Forget one memory by label. The user owns their memory.",
      inputSchema: {
        type: "object",
        properties: { chatId: { type: "string" }, label: { type: "string" } },
        required: ["chatId", "label"],
      },
    },
    async execute(args) {
      const ok = graph.forget(String(args.chatId), String(args.label));
      return {
        toolName: "memory_forget", args, success: true,
        output: ok ? `Forgot "${args.label}".` : `Nothing stored as "${args.label}".`,
      };
    },
  };

  return [remember, recall, link, forget];
}
