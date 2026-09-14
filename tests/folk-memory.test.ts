import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/config/logger.js";
import { MemoryGraph } from "../src/folk/memory-graph.js";

beforeEach(() => {
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  vi.stubEnv("LLM_PROVIDER", "anthropic");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("MemoryGraph", () => {
  it("remembers, searches, links and forgets", () => {
    const g = new MemoryGraph(createLogger(), null);
    g.remember({ chatId: "1", kind: "goal", label: "marathon", detail: "run under 4h in December" });
    g.remember({ chatId: "1", kind: "person", label: "Ama", detail: "gym buddy" });

    expect(g.search("1", "marathon")).toHaveLength(1);
    expect(g.search("1", "")).toHaveLength(2);

    const edge = g.link("1", "Ama", "marathon", "trains for");
    expect(edge?.relation).toBe("trains for");
    expect(g.formatted("1")).toContain("trains for → marathon");

    expect(g.forget("1", "Ama")).toBe(true);
    expect(g.search("1", "Ama")).toHaveLength(0);
  });

  it("updates a node in place when remembered twice", () => {
    const g = new MemoryGraph(createLogger(), null);
    g.remember({ chatId: "1", kind: "preference", label: "gym time", detail: "mornings" });
    g.remember({ chatId: "1", kind: "preference", label: "Gym Time", detail: "evenings" });
    expect(g.list("1")).toHaveLength(1);
    expect(g.find("1", "gym time")?.detail).toBe("evenings");
  });

  it("isolates chats", () => {
    const g = new MemoryGraph(createLogger(), null);
    g.remember({ chatId: "1", kind: "fact", label: "x", detail: "one" });
    expect(g.search("2", "")).toHaveLength(0);
  });
});
