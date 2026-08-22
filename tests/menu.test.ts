import { describe, expect, it } from "vitest";
import {
  capabilitiesPanel,
  homePanel,
  modelPanel,
  personaPanel,
  statusPanel,
  tipsPanel,
} from "../src/telegram/menu.js";
import type { EnvConfig } from "../src/config/env.js";

describe("menu panels", () => {
  it("home greets the user by name and lists actions", () => {
    const p = homePanel("Prince");
    expect(p.text).toContain("Hey Prince");
    expect(p.text).toContain("Boop");
    expect(
      p.keyboard.reply_markup.inline_keyboard.flat().map((b) => "text" in b && b.text),
    ).toContain("🆕 New chat");
  });

  it("capabilities covers links, YouTube and files", () => {
    const p = capabilitiesPanel();
    expect(p.text).toContain("YouTube");
    expect(p.text).toContain("Links");
    expect(p.text).toContain("Files");
  });

  it("tips mention the fresh-start command", () => {
    expect(tipsPanel().text).toContain("/new");
  });

  it("persona shows source and truncates long prompts", () => {
    const long = "x".repeat(600);
    const p = personaPanel("Custom (this chat)", long);
    expect(p.text).toContain("Custom (this chat)");
    expect(p.text).toContain("…");
    expect(p.text.length).toBeLessThan(700);
  });

  it("model and status render their values", () => {
    expect(modelPanel("openai", "openrouter/free").text).toContain("`openrouter/free`");

    const env = { LLM_PROVIDER: "openai", CONVEX_URL: "" } as unknown as EnvConfig;
    const s = statusPanel(env, 7, "memory");
    expect(s.text).toContain("openai");
    expect(s.text).toContain("In-memory");
    expect(s.text).toContain("7 registered");
  });
});
