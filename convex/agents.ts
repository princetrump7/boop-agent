import { v } from "convex/values";
import { mutation } from "./_generated/server.js";

/**
 * Insert a new agent run record.
 */
export const insert = mutation({
  args: {
    chatId: v.number(),
    turnId: v.string(),
    provider: v.string(),
    model: v.string(),
    status: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("agents", {
      ...args,
      startedAt: Date.now(),
    });
  },
});

/**
 * Update an agent run record (status, token counts, error).
 */
export const update = mutation({
  args: {
    chatId: v.number(),
    turnId: v.string(),
    status: v.optional(v.string()),
    completedAt: v.optional(v.number()),
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const agent = await ctx.db
      .query("agents")
      .withIndex("byChatId", (q) => q.eq("chatId", args.chatId))
      .order("desc")
      .first();

    if (!agent) return;

    const patch: Record<string, unknown> = {};
    if (args.status) patch.status = args.status;
    if (args.completedAt !== undefined) patch.completedAt = args.completedAt;
    if (args.inputTokens !== undefined) patch.inputTokens = args.inputTokens;
    if (args.outputTokens !== undefined) patch.outputTokens = args.outputTokens;
    if (args.error !== undefined) patch.error = args.error;

    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(agent._id, patch);
    }
  },
});
