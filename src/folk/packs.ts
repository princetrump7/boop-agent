import type { HabitStore } from "./habit-store.js";
import { parseDays } from "./habit-store.js";
import type { MemoryGraph } from "./memory-graph.js";
import type { HabitTone, MemoryNodeKind } from "./types.js";

export interface PackHabit {
  name: string;
  days: string;
  times: string[];
  tone: HabitTone;
  proofRequired?: boolean;
}

export interface PackMemory {
  kind: MemoryNodeKind;
  label: string;
  detail: string;
}

export interface FolkPack {
  id: string;
  emoji: string;
  name: string;
  category: string;
  tagline: string;
  habits: PackHabit[];
  memories: PackMemory[];
}

/**
 * Boop Packs — folkways parity: one-tap mini-folks.
 * Each pack installs habits (the bot texts first) + seed memories.
 * Better-than-folk: every pack declares its tone + proof rules up front,
 * hiring is idempotent (re-hiring skips what already exists).
 */
export const PACKS: FolkPack[] = [
  {
    id: "workout",
    emoji: "💪",
    name: "Workout accountability",
    category: "fitness",
    tagline: "Daily did-you-train check-in that holds the line, streaks with receipts.",
    habits: [{ name: "workout", days: "daily", times: ["07:00"], tone: "firm", proofRequired: true }],
    memories: [{ kind: "goal", label: "training", detail: "User hired the workout pack — hold the line on training daily." }],
  },
  {
    id: "study",
    emoji: "🎓",
    name: "Study lock-in",
    category: "school",
    tagline: "Weekday lock-in nudge with finish checks.",
    habits: [{ name: "study", days: "weekdays", times: ["09:00", "19:00"], tone: "firm" }],
    memories: [{ kind: "routine", label: "study", detail: "User hired the study pack — lock-in sprints on weekdays." }],
  },
  {
    id: "nag",
    emoji: "🚨",
    name: "Nag me until done",
    category: "productivity",
    tagline: "A relentless daily task nudge that won't let it slide.",
    habits: [{ name: "nag-task", days: "daily", times: ["09:00"], tone: "relentless", proofRequired: true }],
    memories: [],
  },
  {
    id: "mood",
    emoji: "🌙",
    name: "Daily mood check-in",
    category: "wellness",
    tagline: "One gentle question every evening, journaled for you.",
    habits: [{ name: "mood", days: "daily", times: ["21:00"], tone: "gentle" }],
    memories: [{ kind: "routine", label: "mood log", detail: "Evening mood check-in journal — one question a night." }],
  },
  {
    id: "water",
    emoji: "💧",
    name: "Water check",
    category: "wellness",
    tagline: "Counts your glasses through the day and keeps the streak.",
    habits: [{ name: "water", days: "daily", times: ["10:00", "14:00", "18:00"], tone: "steady" }],
    memories: [],
  },
  {
    id: "bible",
    emoji: "📖",
    name: "Daily verse",
    category: "faith",
    tagline: "Your verse every morning, zero guilt-tripping.",
    habits: [{ name: "verse", days: "daily", times: ["06:30"], tone: "gentle" }],
    memories: [{ kind: "routine", label: "daily verse", detail: "Morning verse + reading plan — remember where we left off." }],
  },
  {
    id: "gratitude",
    emoji: "🌸",
    name: "Gratitude journal",
    category: "wellness",
    tagline: "Three good things every night.",
    habits: [{ name: "gratitude", days: "daily", times: ["22:00"], tone: "gentle" }],
    memories: [],
  },
  {
    id: "meds",
    emoji: "💊",
    name: "Medication keeper",
    category: "wellness",
    tagline: "Doses on time, confirmed one by one.",
    habits: [{ name: "meds", days: "daily", times: ["08:00", "20:00"], tone: "firm", proofRequired: true }],
    memories: [],
  },
  {
    id: "screen",
    emoji: "📵",
    name: "Screen-time guard",
    category: "wellness",
    tagline: "Phone-away wind-down nudge every night.",
    habits: [{ name: "phone away", days: "daily", times: ["22:30"], tone: "firm" }],
    memories: [],
  },
  {
    id: "savings",
    emoji: "🐷",
    name: "Savings buddy",
    category: "money",
    tagline: "Weekly savings check-in plus impulse gut-checks.",
    habits: [{ name: "savings", days: "Sun", times: ["18:00"], tone: "steady" }],
    memories: [{ kind: "goal", label: "savings", detail: "User hired the savings buddy — track the running total weekly." }],
  },
  {
    id: "birthdays",
    emoji: "🎂",
    name: "Birthday keeper",
    category: "lifestyle",
    tagline: "Tell me the dates once — Sunday heads-up before they land.",
    habits: [{ name: "birthdays", days: "Sun", times: ["17:00"], tone: "steady" }],
    memories: [{ kind: "fact", label: "birthdays", detail: "Important birthdays/dates — ask the user for each one and remember forever." }],
  },
  {
    id: "brief",
    emoji: "☀️",
    name: "Daily brief+",
    category: "productivity",
    tagline: "Streaks, today's plan, memory highlights — every morning.",
    habits: [],
    memories: [{ kind: "preference", label: "briefing", detail: "User hired daily brief+ — morning briefing is on." }],
  },
  {
    id: "focus",
    emoji: "🎯",
    name: "Deep work",
    category: "productivity",
    tagline: "One protected focus block every weekday.",
    habits: [{ name: "deep work", days: "weekdays", times: ["09:00"], tone: "firm", proofRequired: true }],
    memories: [{ kind: "goal", label: "deep work", detail: "User hired the deep work coach — one protected focus block per weekday." }],
  },
  {
    id: "morning",
    emoji: "🌅",
    name: "Morning routine",
    category: "productivity",
    tagline: "Win the first hour and the day follows.",
    habits: [{ name: "morning routine", days: "daily", times: ["06:00"], tone: "steady" }],
    memories: [],
  },
  {
    id: "code",
    emoji: "💻",
    name: "Code daily",
    category: "productivity",
    tagline: "Ship something every day — streaks with commits.",
    habits: [{ name: "code", days: "daily", times: ["18:00"], tone: "firm", proofRequired: true }],
    memories: [{ kind: "goal", label: "code streak", detail: "User hired the code-daily coach — ship something every day." }],
  },
  {
    id: "run",
    emoji: "🏃",
    name: "Running",
    category: "fitness",
    tagline: "Three runs a week, no excuses, receipts required.",
    habits: [{ name: "run", days: "Mon/Wed/Sat", times: ["06:30"], tone: "firm", proofRequired: true }],
    memories: [],
  },
  {
    id: "diet",
    emoji: "🥗",
    name: "Clean eating",
    category: "fitness",
    tagline: "Nightly honest check on how you ate today.",
    habits: [{ name: "clean meal", days: "daily", times: ["20:00"], tone: "steady" }],
    memories: [],
  },
  {
    id: "sleep",
    emoji: "😴",
    name: "Sleep on time",
    category: "wellness",
    tagline: "Lights out by 11 — the cheapest performance drug.",
    habits: [{ name: "sleep", days: "daily", times: ["23:00"], tone: "steady" }],
    memories: [],
  },
  {
    id: "journal",
    emoji: "✍️",
    name: "Journaling",
    category: "wellness",
    tagline: "Two lines a night — your future self says thanks.",
    habits: [{ name: "journal", days: "daily", times: ["22:00"], tone: "gentle" }],
    memories: [],
  },
  {
    id: "reading",
    emoji: "📚",
    name: "Reading",
    category: "lifestyle",
    tagline: "Twenty pages a night, every night.",
    habits: [{ name: "reading", days: "daily", times: ["21:30"], tone: "gentle" }],
    memories: [],
  },
  {
    id: "language",
    emoji: "🗣️",
    name: "Language streak",
    category: "school",
    tagline: "A little every morning — streaks beat cramming.",
    habits: [{ name: "language", days: "daily", times: ["08:00"], tone: "steady" }],
    memories: [{ kind: "goal", label: "language", detail: "User hired the language coach — ask which language and track it." }],
  },
  {
    id: "nospend",
    emoji: "💰",
    name: "No-spend days",
    category: "money",
    tagline: "Weekday spending check — keep the wallet shut.",
    habits: [{ name: "no-spend", days: "weekdays", times: ["21:00"], tone: "firm" }],
    memories: [{ kind: "goal", label: "no-spend", detail: "User hired the no-spend coach — report spending honestly each weeknight." }],
  },
  {
    id: "tidy",
    emoji: "🧹",
    name: "Tidy home",
    category: "lifestyle",
    tagline: "Weekend reset — room clean, head clean.",
    habits: [{ name: "tidy", days: "weekends", times: ["10:00"], tone: "steady" }],
    memories: [],
  },
  {
    id: "family",
    emoji: "📞",
    name: "Call family",
    category: "lifestyle",
    tagline: "One call home every Sunday.",
    habits: [{ name: "call home", days: "Sun", times: ["16:00"], tone: "gentle" }],
    memories: [{ kind: "fact", label: "family", detail: "User hired the family coach — ask who to call and remember them." }],
  },
];

export interface HireResult {
  pack: FolkPack;
  habitsCreated: string[];
  habitsSkipped: string[];
  memoriesCreated: string[];
}

/** Hire a pack: install habits + seed memories, skipping what already exists. */
export function hirePack(
  packId: string,
  chatId: string,
  userId: string,
  habits: HabitStore,
  memory: MemoryGraph,
): HireResult | undefined {
  const pack = PACKS.find((p) => p.id === packId.toLowerCase().trim());
  if (!pack) return undefined;
  const result: HireResult = { pack, habitsCreated: [], habitsSkipped: [], memoriesCreated: [] };
  for (const h of pack.habits) {
    if (habits.findByName(chatId, h.name)) {
      result.habitsSkipped.push(h.name);
      continue;
    }
    const { days, times } = { days: parseDays(h.days), times: h.times };
    habits.create({
      chatId,
      userId,
      name: h.name,
      schedule: { days, times },
      tone: h.tone,
      proofRequired: h.proofRequired ?? false,
    });
    result.habitsCreated.push(h.name);
  }
  for (const m of pack.memories) {
    memory.remember({ chatId, kind: m.kind, label: m.label, detail: m.detail });
    result.memoriesCreated.push(m.label);
  }
  return result;
}
