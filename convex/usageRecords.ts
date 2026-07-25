import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";

/**
 * Insert a usage record after an agent turn.
 */
export const insert = mutation({
  args: {
    chatId: v.number(),
    turnId: v.string(),
    date: v.string(),
    provider: v.string(),
    model: v.string(),
    inputTokens: v.number(),
    outputTokens: v.number(),
    inputCost: v.number(),
    outputCost: v.number(),
    totalCost: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("usageRecords", {
      ...args,
      createdAt: Date.now(),
    });
  },
});

/**
 * Sum token usage and cost for a chat.
 */
export const sumByChat = query({
  args: { chatId: v.number() },
  handler: async (ctx, args) => {
    const records = await ctx.db
      .query("usageRecords")
      .withIndex("byChatId", (q) => q.eq("chatId", args.chatId))
      .collect();

    return {
      totalInputTokens: records.reduce((s, r) => s + r.inputTokens, 0),
      totalOutputTokens: records.reduce((s, r) => s + r.outputTokens, 0),
      totalCost: records.reduce((s, r) => s + r.totalCost, 0),
      count: records.length,
    };
  },
});
