import type { Logger } from "../config/logger.js";
import type { Tool } from "./types.js";
import type { HabitStore } from "../folk/habit-store.js";
import { formatDays, isValidTime, parseDays } from "../folk/habit-store.js";
import type { HabitTone } from "../folk/types.js";

const TONES: HabitTone[] = ["gentle", "steady", "firm", "relentless"];

/**
 * folk habit tools — let the LLM turn plain language
 * ("gym Mon/Wed/Fri at 7, be relentless, ask for proof")
 * into structured accountability.
 */
export function createFolkHabitTools(habits: HabitStore, logger: Logger): Tool[] {
  const log = logger.child({ component: "FolkHabitTools" });

  const create: Tool = {
    definition: {
      name: "habit_create",
      description:
        "Create a proactive accountability habit. The bot will text the user first at each scheduled time. Days like 'Mon/Wed/Fri', 'daily', 'weekdays'. Times are HH:MM 24h.",
      inputSchema: {
        type: "object",
        properties: {
          chatId: { type: "string" },
          userId: { type: "string" },
          name: { type: "string", description: "Short name, e.g. 'gym', 'study', 'no sugar'" },
          days: { type: "string", description: "e.g. 'Mon/Wed/Fri', 'daily', 'weekdays'" },
          times: { type: "array", items: { type: "string" }, description: "e.g. ['07:00', '21:00']" },
          tone: { type: "string", enum: TONES, default: "steady" },
          proofRequired: { type: "boolean", default: false },
        },
        required: ["chatId", "userId", "name", "days", "times"],
      },
    },
    async execute(args) {
      try {
        const days = parseDays(String(args.days ?? ""));
        const times = Array.isArray(args.times) ? args.times.map(String) : [];
        if (days.length === 0) return { toolName: "habit_create", args, output: "", success: false, error: "Could not parse days — use Mon/Tue/… or 'daily'." };
        if (times.length === 0 || !times.every(isValidTime)) {
          return { toolName: "habit_create", args, output: "", success: false, error: "Times must be HH:MM 24h, e.g. ['07:00']." };
        }
        const tone = TONES.includes(args.tone as HabitTone) ? (args.tone as HabitTone) : "steady";
        const h = habits.create({
          chatId: String(args.chatId),
          userId: String(args.userId),
          name: String(args.name),
          schedule: { days, times },
          tone,
          proofRequired: Boolean(args.proofRequired),
        });
        return {
          toolName: "habit_create", args, success: true,
          output: `Habit "${h.name}" created: ${formatDays(h.schedule.days)} @ ${h.schedule.times.join(", ")} (tone: ${h.tone}${h.proofRequired ? ", proof required" : ""}). I'll text first.`,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ error: message }, "habit_create failed");
        return { toolName: "habit_create", args, output: "", success: false, error: message };
      }
    },
  };

  const list: Tool = {
    definition: {
      name: "habit_list",
      description: "List the user's accountability habits with streaks and schedules.",
      inputSchema: {
        type: "object",
        properties: { chatId: { type: "string" } },
        required: ["chatId"],
      },
    },
    async execute(args) {
      const all = habits.list(String(args.chatId));
      if (all.length === 0) return { toolName: "habit_list", args, output: "No habits yet.", success: true };
      const lines = all.map(
        (h) => `• ${h.name} — ${formatDays(h.schedule.days)} @ ${h.schedule.times.join(", ")} — streak 🔥${h.streak} (best ${h.longestStreak}) — ${h.paused ? "paused" : h.tone}${h.proofRequired ? " — proof required" : ""}`,
      );
      return { toolName: "habit_list", args, output: lines.join("\n"), success: true };
    },
  };

  const logTool: Tool = {
    definition: {
      name: "habit_log",
      description: "Log a habit check-in as done/missed/skipped. Misses use a streak freeze first if available.",
      inputSchema: {
        type: "object",
        properties: {
          chatId: { type: "string" },
          name: { type: "string" },
          status: { type: "string", enum: ["done", "missed", "skipped"] },
          proof: { type: "string" },
        },
        required: ["chatId", "name", "status"],
      },
    },
    async execute(args) {
      const h = habits.findByName(String(args.chatId), String(args.name ?? ""));
      if (!h) return { toolName: "habit_log", args, output: "", success: false, error: `No habit named "${args.name}".` };
      habits.log(h.id, args.status as "done" | "missed" | "skipped", args.proof ? String(args.proof) : undefined);
      const cur = habits.get(h.id)!;
      return {
        toolName: "habit_log", args, success: true,
        output: `Logged "${cur.name}" as ${args.status}. Streak 🔥${cur.streak} (best ${cur.longestStreak}, freezes left: ${cur.freezes}).`,
      };
    },
  };

  return [create, list, logTool];
}
