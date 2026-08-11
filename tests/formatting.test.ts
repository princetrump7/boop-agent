import type { Context } from "telegraf";
import { describe, expect, it, vi } from "vitest";
import { commandList, escapeMarkdown, kv, sendLongMessage } from "../src/telegram/formatting.js";

function fakeCtx() {
  const reply = vi.fn<Context["reply"]>().mockResolvedValue({} as never);
  return { reply, ctx: { reply } as unknown as Context };
}

describe("escapeMarkdown", () => {
  it("escapes Telegram legacy markdown special characters", () => {
    expect(escapeMarkdown("a *b* _c_ `d` [e]")).toBe("a \\*b\\* \\_c\\_ \\`d\\` \\[e]");
  });

  it("escapes backslashes", () => {
    expect(escapeMarkdown("\\")).toBe("\\\\");
  });

  it("leaves plain text untouched", () => {
    expect(escapeMarkdown("plain text 123 — ok")).toBe("plain text 123 — ok");
  });
});

describe("kv", () => {
  it("formats a label/value line", () => {
    expect(kv("Provider", "anthropic")).toBe("*Provider* — anthropic");
  });
});

describe("commandList", () => {
  it("formats commands as monospaced lines", () => {
    expect(commandList([["/new", "fresh conversation"]])).toBe("`/new` — fresh conversation");
  });

  it("formats multiple commands joined by newlines", () => {
    expect(
      commandList([
        ["/new", "fresh conversation"],
        ["/status", "show configuration"],
      ]),
    ).toBe("`/new` — fresh conversation\n`/status` — show configuration");
  });
});

describe("sendLongMessage", () => {
  it("sends short messages in a single reply with markdown", async () => {
    const { reply, ctx } = fakeCtx();
    await sendLongMessage(ctx, "*Hello*");
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith("*Hello*", {
      parse_mode: "Markdown",
    });
  });

  it("splits messages longer than Telegram's limit", async () => {
    const { reply, ctx } = fakeCtx();
    const paragraphs = Array.from(
      { length: 30 },
      (_, i) => `Paragraph ${i + 1}: ${"x".repeat(200)}`,
    );
    const text = paragraphs.join("\n\n");

    await sendLongMessage(ctx, text);

    expect(reply.mock.calls.length).toBeGreaterThan(1);
    let reassembled = "";
    for (const call of reply.mock.calls) {
      const chunk = call[0] as string;
      expect(chunk.length).toBeLessThanOrEqual(4096);
      reassembled += reassembled ? `\n\n${chunk}` : chunk;
    }
    // Splitting preserves the full content (paragraphs joined back with
    // the same double-newline separators).
    expect(reassembled).toBe(text);
  });

  it("falls back to plain text when markdown parsing fails", async () => {
    const { reply, ctx } = fakeCtx();
    reply.mockRejectedValueOnce(new Error("parse failed"));

    await sendLongMessage(ctx, "*bold* text");

    expect(reply).toHaveBeenCalledTimes(2);
    expect(reply.mock.calls[1][0]).toBe("bold text");
  });
});
