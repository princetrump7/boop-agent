import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/config/logger.js";
import { InMemorySystemPromptStore } from "../src/agent/system-prompt.js";

beforeEach(() => {
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  vi.stubEnv("LLM_PROVIDER", "anthropic");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("InMemorySystemPromptStore", () => {
  it("stores and retrieves prompts per chat", async () => {
    const store = new InMemorySystemPromptStore(createLogger());

    await store.set("chat-1", "You are a pirate.");
    await store.set("chat-2", "You are a poet.");

    expect(await store.get("chat-1")).toBe("You are a pirate.");
    expect(await store.get("chat-2")).toBe("You are a poet.");
    expect(await store.get("chat-3")).toBeUndefined();
  });

  it("overwrites an existing prompt", async () => {
    const store = new InMemorySystemPromptStore(createLogger());

    await store.set("chat-1", "first");
    await store.set("chat-1", "second");

    expect(await store.get("chat-1")).toBe("second");
  });

  it("clears a prompt", async () => {
    const store = new InMemorySystemPromptStore(createLogger());

    await store.set("chat-1", "prompt");
    await store.clear("chat-1");

    expect(await store.get("chat-1")).toBeUndefined();
  });
});
