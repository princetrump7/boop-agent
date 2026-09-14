import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/config/logger.js";
import { resetEnvCache } from "../src/config/env.js";
import { HabitStore } from "../src/folk/habit-store.js";
import { MemoryGraph } from "../src/folk/memory-graph.js";
import { runFolkTick } from "../src/telegram/folk.js";
import { buildMorningBriefing } from "../src/folk/briefing.js";

beforeEach(() => {
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  vi.stubEnv("LLM_PROVIDER", "anthropic");
  vi.stubEnv("TIMEZONE", "Africa/Accra");
  resetEnvCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

describe("runFolkTick", () => {
  it("texts first when a check-in is due, then stays quiet", async () => {
    const logger = createLogger();
    const habits = new HabitStore(logger, null);
    const memory = new MemoryGraph(logger, null);
    habits.create({ chatId: "99", userId: "u", name: "gym", schedule: { days: [1], times: ["07:00"] }, tone: "firm" });

    const sent: Array<{ chatId: string; text: string }> = [];
    const deps = {
      habits, memory,
      send: async (chatId: string, text: string) => { sent.push({ chatId, text }); },
      logger,
    };
    // Monday 08:00 Accra — 07:00 check-in is due
    await runFolkTick(new Date("2026-09-14T08:00:00Z"), deps);
    expect(sent).toHaveLength(1);
    expect(sent[0].chatId).toBe("99");
    expect(sent[0].text).toContain("gym");

    // Second tick at 08:01 — already sent, no duplicate (briefing hour is 7, not 8)
    sent.length = 0;
    await runFolkTick(new Date("2026-09-14T08:01:00Z"), deps);
    expect(sent).toHaveLength(0);
  });

  it("sends the morning briefing once per day", async () => {
    const logger = createLogger();
    const habits = new HabitStore(logger, null);
    const memory = new MemoryGraph(logger, null);
    habits.create({ chatId: "7", userId: "u", name: "read", schedule: { days: [1, 2, 3, 4, 5, 6, 7], times: ["21:00"] } });

    const sent: string[] = [];
    const deps = {
      habits, memory,
      send: async (chatId: string, text: string) => { sent.push(`${chatId}:${text.slice(0, 20)}`); },
      logger,
    };
    await runFolkTick(new Date("2026-09-14T07:05:00Z"), deps);
    expect(sent.some((s) => s.startsWith("7:"))).toBe(true);
    const n = sent.length;
    await runFolkTick(new Date("2026-09-14T07:06:00Z"), deps);
    expect(sent.length).toBe(n); // no duplicate briefing
  });
});

describe("buildMorningBriefing", () => {
  it("renders streaks, plan and memory", () => {
    const logger = createLogger();
    const habits = new HabitStore(logger, null);
    const memory = new MemoryGraph(logger, null);
    habits.create({ chatId: "1", userId: "u", name: "gym", schedule: { days: [1, 3, 5], times: ["07:00"] } });
    memory.remember({ chatId: "1", kind: "goal", label: "marathon", detail: "under 4h" });
    const text = buildMorningBriefing({ chatId: "1", date: "2026-09-14", habits, memory });
    expect(text).toContain("gym");
    expect(text).toContain("marathon");
    expect(text).toContain("Accountability score");
  });
});
