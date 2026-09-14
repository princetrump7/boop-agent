import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/config/logger.js";
import { HabitStore } from "../src/folk/habit-store.js";
import { MemoryGraph } from "../src/folk/memory-graph.js";
import { PACKS, hirePack } from "../src/folk/packs.js";

beforeEach(() => {
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  vi.stubEnv("LLM_PROVIDER", "anthropic");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Boop Packs", () => {
  it("ships a gallery covering folkways essentials", () => {
    const ids = PACKS.map((p) => p.id);
    for (const id of ["workout", "study", "nag", "mood", "water", "bible", "savings", "brief"]) {
      expect(ids).toContain(id);
    }
  });

  it("hires habits + memories and texts-first from then on", () => {
    const logger = createLogger();
    const habits = new HabitStore(logger, null);
    const memory = new MemoryGraph(logger, null);
    const r = hirePack("workout", "1", "u", habits, memory)!;
    expect(r.habitsCreated).toContain("workout");
    const h = habits.findByName("1", "workout")!;
    expect(h.tone).toBe("firm");
    expect(h.proofRequired).toBe(true);
    expect(memory.search("1", "training")).toHaveLength(1);
  });

  it("is idempotent — re-hiring skips active habits", () => {
    const logger = createLogger();
    const habits = new HabitStore(logger, null);
    const memory = new MemoryGraph(logger, null);
    hirePack("mood", "1", "u", habits, memory);
    const again = hirePack("mood", "1", "u", habits, memory)!;
    expect(again.habitsCreated).toHaveLength(0);
    expect(again.habitsSkipped).toContain("mood");
    expect(habits.list("1").filter((h) => h.name === "mood")).toHaveLength(1);
  });

  it("returns undefined for unknown packs", () => {
    const logger = createLogger();
    expect(hirePack("nope", "1", "u", new HabitStore(logger, null), new MemoryGraph(logger, null))).toBeUndefined();
  });
});
