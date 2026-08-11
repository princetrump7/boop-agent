import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";

/**
 * Insert a new draft.
 */
export const insert = mutation({
  args: {
    chatId: v.number(),
    turnId: v.optional(v.string()),
    title: v.string(),
    content: v.string(),
    type: v.optional(v.string()),
    status: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    return await ctx.db.insert("drafts", {
      chatId: args.chatId,
      turnId: args.turnId,
      title: args.title,
      content: args.content,
      type: args.type,
      status: args.status ?? "draft",
      createdAt: now,
      updatedAt: now,
    });
  },
});

/**
 * List drafts for a chat, optionally filtered by status.
 */
export const listByChatStatus = query({
  args: {
    chatId: v.number(),
    status: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (args.status) {
      return await ctx.db
        .query("drafts")
        .withIndex("byChatIdStatus", (q) => q.eq("chatId", args.chatId!).eq("status", args.status!))
        .collect();
    }
    return await ctx.db
      .query("drafts")
      .withIndex("byChatIdStatus", (q) => q.eq("chatId", args.chatId))
      .collect();
  },
});

/**
 * Update a draft's status (e.g. "confirmed" or "rejected").
 */
export const updateStatus = mutation({
  args: {
    chatId: v.number(),
    draftId: v.id("drafts"),
    status: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.draftId, {
      status: args.status,
      updatedAt: Date.now(),
    });
  },
});
