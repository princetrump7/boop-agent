import type { Context } from "telegraf";
import { describe, expect, it } from "vitest";
import { extractCommandArgs } from "../src/telegram/commands.js";

function fakeCtx(text: string): Context {
  return { message: { text } } as unknown as Context;
}

describe("extractCommandArgs", () => {
  it("returns the text after the command", () => {
    expect(extractCommandArgs(fakeCtx("/system set You are a pirate."))).toBe(
      "set You are a pirate.",
    );
  });

  it("handles the @botname command suffix", () => {
    expect(extractCommandArgs(fakeCtx("/system@BoopBot reset"))).toBe("reset");
  });

  it("returns an empty string for a bare command", () => {
    expect(extractCommandArgs(fakeCtx("/system"))).toBe("");
  });

  it("strips leading whitespace before the command", () => {
    expect(extractCommandArgs(fakeCtx("  /system  set hello"))).toBe("set hello");
  });
});
