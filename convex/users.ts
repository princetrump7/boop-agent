import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";

/**
 * Upsert a user record by telegramId.
 */
export const upsertUser = mutation({
  args: {
    telegramId: v.number(),
    username: v.optional(v.string()),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("users")
      .withIndex("byTelegramId", (q) => q.eq("telegramId", args.telegramId))
      .unique();

    const now = Date.now();

    if (existing) {
      await ctx.db.patch(existing._id, {
        username: args.username ?? existing.username,
        firstName: args.firstName ?? existing.firstName,
        lastName: args.lastName ?? existing.lastName,
        updatedAt: now,
      });
      return existing._id;
    }

    return await ctx.db.insert("users", {
      telegramId: args.telegramId,
      username: args.username,
      firstName: args.firstName,
      lastName: args.lastName,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/**
 * Check if a user is authorized and active.
 */
export const isAuthorized = query({
  args: { telegramId: v.number() },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("byTelegramId", (q) => q.eq("telegramId", args.telegramId))
      .unique();
    return user?.isActive ?? false;
  },
});

/**
 * Set a user's active status (enable / disable).
 */
export const setActiveStatus = mutation({
  args: {
    telegramId: v.number(),
    isActive: v.boolean(),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("byTelegramId", (q) => q.eq("telegramId", args.telegramId))
      .unique();
    if (user) {
      await ctx.db.patch(user._id, { isActive: args.isActive, updatedAt: Date.now() });
    }
  },
});
