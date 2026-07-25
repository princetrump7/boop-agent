import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";

/**
 * Get a setting by key for a chat.
 */
export const get = query({
  args: { chatId: v.number(), key: v.string() },
  handler: async (ctx, args) => {
    const setting = await ctx.db
      .query("settings")
      .withIndex("byChatId", (q) => q.eq("chatId", args.chatId))
      .first();
    return setting?.config?.[args.key];
  },
});

/**
 * Set a config value for a chat (upsert).
 */
export const set = mutation({
  args: {
    chatId: v.number(),
    config: v.object({}),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("settings")
      .withIndex("byChatId", (q) => q.eq("chatId", args.chatId))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        config: { ...existing.config, ...args.config },
        updatedAt: Date.now(),
      });
    } else {
      await ctx.db.insert("settings", {
        chatId: args.chatId,
        config: args.config,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
  },
});

/**
 * List all settings (for debugging / status).
 */
export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("settings").collect();
  },
});
