import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";

/**
 * Insert a new message into a chat.
 */
export const insert = mutation({
  args: {
    chatId: v.number(),
    turnId: v.optional(v.string()),
    role: v.string(),
    content: v.string(),
    toolCalls: v.optional(v.any()),
    toolResults: v.optional(v.any()),
    usage: v.optional(
      v.object({
        inputTokens: v.number(),
        outputTokens: v.number(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("messages", {
      chatId: args.chatId,
      turnId: args.turnId,
      role: args.role,
      content: args.content,
      toolCalls: args.toolCalls,
      toolResults: args.toolResults,
      usage: args.usage,
      createdAt: Date.now(),
    });
  },
});

/**
 * List messages for a chat, newest first, capped at `limit`.
 */
export const listByChat = query({
  args: {
    chatId: v.number(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 50;
    return await ctx.db
      .query("messages")
      .withIndex("byChatId", (q) => q.eq("chatId", args.chatId))
      .order("desc")
      .take(limit);
  },
});

/**
 * List messages for a specific turn.
 */
export const listByTurn = query({
  args: {
    chatId: v.number(),
    turnId: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("messages")
      .withIndex("byChatIdTurnId", (q) => q.eq("chatId", args.chatId).eq("turnId", args.turnId))
      .collect();
  },
});

/**
 * Delete all messages for a chat.
 */
export const deleteByChat = mutation({
  args: { chatId: v.number() },
  handler: async (ctx, args) => {
    const messages = await ctx.db
      .query("messages")
      .withIndex("byChatId", (q) => q.eq("chatId", args.chatId))
      .collect();
    for (const msg of messages) {
      await ctx.db.delete(msg._id);
    }
  },
});
