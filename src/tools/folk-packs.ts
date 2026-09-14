import type { Logger } from "../config/logger.js";
import type { Tool } from "./types.js";
import type { HabitStore } from "../folk/habit-store.js";
import type { MemoryGraph } from "../folk/memory-graph.js";
import { PACKS, hirePack } from "../folk/packs.js";

/** Pack tools — "hire the workout mini-folk" works in plain language. */
export function createFolkPackTools(habits: HabitStore, memory: MemoryGraph, logger: Logger): Tool[] {
  const log = logger.child({ component: "FolkPackTools" });

  const list: Tool = {
    definition: {
      name: "pack_list",
      description: "List hireable mini-folk packs (workout, study, nag, mood, water, bible, gratitude, meds, screen, savings, birthdays, brief).",
      inputSchema: { type: "object", properties: { category: { type: "string" } } },
    },
    async execute(args) {
      const cat = args.category ? String(args.category).toLowerCase() : null;
      const packs = cat ? PACKS.filter((p) => p.category === cat) : PACKS;
      if (packs.length === 0) return { toolName: "pack_list", args, output: "No packs in that category.", success: true };
      return {
        toolName: "pack_list", args, success: true,
        output: packs.map((p) => `${p.emoji} ${p.id} — ${p.name} [${p.category}]: ${p.tagline}`).join("\n"),
      };
    },
  };

  const hire: Tool = {
    definition: {
      name: "pack_hire",
      description: "Hire a mini-folk pack for the user. Installs its check-ins (bot texts first) + seed memories.",
      inputSchema: {
        type: "object",
        properties: {
          chatId: { type: "string" },
          userId: { type: "string" },
          packId: { type: "string", description: "e.g. 'workout', 'study', 'nag', 'mood'" },
        },
        required: ["chatId", "userId", "packId"],
      },
    },
    async execute(args) {
      try {
        const r = hirePack(String(args.packId ?? ""), String(args.chatId), String(args.userId), habits, memory);
        if (!r) {
          return { toolName: "pack_hire", args, output: "", success: false, error: `No pack "${args.packId}". Use pack_list to see them.` };
        }
        const bits = [
          `${r.pack.emoji} Hired "${r.pack.name}".`,
          ...r.habitsCreated.map((h) => `+ check-ins for ${h} — I'll text first`),
          ...r.habitsSkipped.map((h) => `= ${h} already active`),
        ];
        return { toolName: "pack_hire", args, output: bits.join("\n"), success: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ error: message }, "pack_hire failed");
        return { toolName: "pack_hire", args, output: "", success: false, error: message };
      }
    },
  };

  return [list, hire];
}
