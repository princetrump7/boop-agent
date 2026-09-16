import { formatDays } from "./habit-store.js";
import type { MemoryGraph } from "./memory-graph.js";
import type { HabitStore } from "./habit-store.js";

export interface BriefingInput {
  chatId: string;
  date: string;
  name?: string;
  habits: HabitStore;
  memory: MemoryGraph;
  digestSummary?: string;
}

/** Morning briefing — folk.com parity: streaks, today's plan, memory, digest. */
export function buildMorningBriefing(input: BriefingInput): string {
  const { chatId, date, habits, memory, digestSummary } = input;
  const all = habits.list(chatId).filter((h) => !h.paused);
  const score = habits.score(chatId);
  const pending = habits.pendingFor(chatId);
  const mem = memory.formatted(chatId, 12);

  const lines: string[] = [];
  lines.push(`*Today — ${date}*`);
  if (input.name) lines.push(`Morning, ${input.name}.`);
  lines.push("");
  lines.push(`Accountability score: *${score.pct}%* (${score.done}/${score.scheduled} last 7d)`);
  lines.push("");
  if (all.length === 0) {
    lines.push("No habits yet. Send `gym Mon/Wed/Fri at 07:00` and I'll check in on you every time.");
  } else {
    lines.push("*Today*");
    for (const h of all) {
      const sched = `${formatDays(h.schedule.days)} · ${h.schedule.times.join(", ")}`;
      const streak = h.streak > 0 ? ` — ${h.streak}d streak` : "";
      lines.push(`• *${h.name}* — ${sched}${streak}`);
    }
  }
  if (pending.length > 0) {
    lines.push("");
    lines.push("*Waiting on you*");
    for (const { habit, checkin } of pending) {
      lines.push(`• ${habit.name} (${checkin.date} ${checkin.scheduledTime}) — \`/done ${habit.name}\``);
    }
  }
  if (mem) {
    lines.push("");
    lines.push(`*Remembered*`);
    lines.push(mem.split("\n").slice(1, 8).join("\n"));
  }
  if (digestSummary) {
    lines.push("");
    lines.push(`*From your chats*`);
    lines.push(digestSummary.slice(0, 900));
  }
  lines.push("");
  lines.push(`Reply DONE when you finish — I keep the streak.`);
  return lines.join("\n");
}

export function buildWindDown(habits: HabitStore, chatId: string): string {
  const all = habits.list(chatId).filter((h) => !h.paused);
  const doneToday = habits.pendingFor(chatId).length === 0;
  if (all.length === 0) return `*Wind-down* — nothing scheduled. Sleep well; send one goal for tomorrow and I'll hold you to it.`;
  if (doneToday) return `*Wind-down* — all check-ins closed. Streaks safe. Phone down.`;
  const names = habits.pendingFor(chatId).map(({ habit }) => habit.name).join(", ");
  return `*Wind-down* — still open: ${names}. Log it (\`/done <name>\`) or it counts as a miss at midnight.`;
}
