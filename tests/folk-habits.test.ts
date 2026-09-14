import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/config/logger.js";
import { HabitStore, formatDays, parseDays } from "../src/folk/habit-store.js";

beforeEach(() => {
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  vi.stubEnv("LLM_PROVIDER", "anthropic");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function store() {
  return new HabitStore(createLogger(), null);
}

describe("parseDays / formatDays", () => {
  it("parses common shorthands", () => {
    expect(parseDays("daily")).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(parseDays("weekdays")).toEqual([1, 2, 3, 4, 5]);
    expect(parseDays("Mon/Wed/Fri")).toEqual([1, 3, 5]);
  });

  it("round-trips labels", () => {
    expect(formatDays([1, 2, 3, 4, 5, 6, 7])).toBe("daily");
    expect(formatDays([1, 3, 5])).toBe("Mon/Wed/Fri");
  });
});

describe("HabitStore", () => {
  it("creates and lists habits per chat", () => {
    const s = store();
    s.create({ chatId: "1", userId: "u", name: "gym", schedule: { days: [1, 3, 5], times: ["07:00"] }, tone: "relentless", proofRequired: true });
    expect(s.list("1")).toHaveLength(1);
    expect(s.list("2")).toHaveLength(0);
  });

  it("flags due check-ins once, then marks them sent", () => {
    const s = store();
    // 2026-09-14 is a Monday; Africa/Accra == UTC (no DST)
    s.create({ chatId: "1", userId: "u", name: "gym", schedule: { days: [1], times: ["07:00"] } });
    const now = new Date("2026-09-14T08:00:00Z");
    const due = s.dueToSend(now, "Africa/Accra");
    expect(due).toHaveLength(1);
    s.markSent(due[0].habit.id, due[0].date, due[0].time);
    expect(s.dueToSend(now, "Africa/Accra")).toHaveLength(0);
  });

  it("does not flag future times", () => {
    const s = store();
    s.create({ chatId: "1", userId: "u", name: "read", schedule: { days: [1], times: ["21:00"] } });
    expect(s.dueToSend(new Date("2026-09-14T08:00:00Z"), "Africa/Accra")).toHaveLength(0);
  });

  it("grows streaks on done and spends a freeze before resetting", () => {
    const s = store();
    const h = s.create({ chatId: "1", userId: "u", name: "gym", schedule: { days: [1, 2, 3, 4, 5, 6, 7], times: ["07:00"] } });
    s.log(h.id, "done");
    expect(s.get(h.id)!.streak).toBe(1);
    s.log(h.id, "missed"); // freeze saves the streak
    expect(s.get(h.id)!.streak).toBe(1);
    expect(s.get(h.id)!.freezes).toBe(0);
    s.log(h.id, "missed"); // no freezes left → reset
    expect(s.get(h.id)!.streak).toBe(0);
  });

  it("computes an accountability score", () => {
    const s = store();
    const h = s.create({ chatId: "1", userId: "u", name: "gym", schedule: { days: [1], times: ["07:00"] } });
    s.log(h.id, "done");
    s.log(h.id, "done");
    s.log(h.id, "missed");
    const score = s.score("1");
    expect(score.scheduled).toBe(3);
    expect(score.done).toBe(2);
    expect(score.pct).toBe(67);
  });
});
