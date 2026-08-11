import { afterEach, describe, expect, it, vi } from "vitest";

const BASE_ENV: Record<string, string> = {
  TELEGRAM_BOT_TOKEN: "test-token",
  ANTHROPIC_API_KEY: "test-key",
};

async function loadEnv(overrides: Record<string, string> = {}) {
  vi.resetModules();
  const merged = { ...BASE_ENV, ...overrides };
  for (const [key, value] of Object.entries(merged)) {
    vi.stubEnv(key, value);
  }
  return import("../src/config/env.js");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getEnv", () => {
  it("throws when the Telegram bot token is missing", async () => {
    const env = await loadEnv({ TELEGRAM_BOT_TOKEN: "" });
    expect(() => env.getEnv()).toThrow(/TELEGRAM_BOT_TOKEN/);
  });

  it("defaults the provider to anthropic", async () => {
    const env = await loadEnv();
    expect(env.getEnv().LLM_PROVIDER).toBe("anthropic");
  });

  it("throws when openai is selected without an API key", async () => {
    const env = await loadEnv({ LLM_PROVIDER: "openai" });
    expect(() => env.getEnv()).toThrow(/OPENAI_API_KEY/);
  });

  it("accepts openai with an API key", async () => {
    const env = await loadEnv({
      LLM_PROVIDER: "openai",
      OPENAI_API_KEY: "sk-test",
    });
    expect(env.getEnv().LLM_PROVIDER).toBe("openai");
  });

  it("parses comma-separated authorized user ids", async () => {
    const env = await loadEnv({ AUTHORIZED_USER_IDS: "1, 2,3" });
    expect(env.getEnv().AUTHORIZED_USER_IDS).toEqual([1, 2, 3]);
  });
});
