import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";

/**
 * Upsert (create or update) a conversation for a chat.
 */
export const upsert = mutation({
  args: {
    telegramId: v.number(),
    chatId: v.number(),
    title: v.optional(v.string()),
    model: v.optional(v.string()),
    systemPrompt: v.optional(v.string()),
    lastTurnId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("conversations")
      .withIndex("byTelegramId", (q) => q.eq("telegramId", args.telegramId))
      .first();

    const now = Date.now();

    if (existing) {
      await ctx.db.patch(existing._id, {
        chatId: args.chatId,
        title: args.title ?? existing.title,
        model: args.model ?? existing.model,
        systemPrompt: args.systemPrompt ?? existing.systemPrompt,
        lastTurnId: args.lastTurnId ?? existing.lastTurnId,
        updatedAt: now,
      });
      return existing._id;
    }

    return await ctx.db.insert("conversations", {
      telegramId: args.telegramId,
      chatId: args.chatId,
      title: args.title,
      model: args.model,
      systemPrompt: args.systemPrompt,
      lastTurnId: args.lastTurnId,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/**
 * Get a conversation by telegramId.
 */
export const get = query({
  args: { telegramId: v.number() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("conversations")
      .withIndex("byTelegramId", (q) => q.eq("telegramId", args.telegramId))
      .first();
  },
});
