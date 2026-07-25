import { v } from "convex/values";
import { mutation } from "./_generated/server.js";

/**
 * Insert an agent log entry (tool call, result, error, llm_call).
 */
export const insert = mutation({
  args: {
    chatId: v.number(),
    turnId: v.string(),
    agentId: v.optional(v.string()),
    step: v.number(),
    type: v.string(),
    toolName: v.optional(v.string()),
    input: v.optional(v.string()),
    output: v.optional(v.string()),
    duration: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("agentLogs", {
      ...args,
      createdAt: Date.now(),
    });
  },
});
