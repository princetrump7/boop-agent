import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";

/**
 * Insert a memory record with auto-calculated decay rate.
 * Tiers: "short" → 0.05, "long" → 0.02, "permanent" → 0
 */
export const insert = mutation({
  args: {
    chatId: v.number(),
    telegramId: v.optional(v.number()),
    memoryId: v.string(),
    content: v.string(),
    category: v.optional(v.string()),
    importance: v.optional(v.number()),
    tier: v.string(),
    embedding: v.optional(v.array(v.float64())),
    expiresAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const decayRates: Record<string, number> = {
      short: 0.05,
      long: 0.02,
      permanent: 0,
    };

    return await ctx.db.insert("memoryRecords", {
      chatId: args.chatId,
      telegramId: args.telegramId,
      memoryId: args.memoryId,
      content: args.content,
      category: args.category,
      importance: args.importance,
      tier: args.tier,
      decayRate: decayRates[args.tier] ?? 0.05,
      decayStartedAt: now,
      lastAccessedAt: now,
      accessCount: 0,
      expiresAt: args.expiresAt,
      embedding: args.embedding,
      createdAt: now,
    });
  },
});

/**
 * Search memory records by vector embedding.
 * Results are scored by proximity; client-side filter by content substring.
 */
export const search = query({
  args: {
    chatId: v.number(),
    queryEmbedding: v.array(v.float64()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 5;
    return await ctx.db
      .query("memoryRecords")
      .withIndex("byEmbedding", (q) =>
        q.eq("chatId", args.chatId)
      )
      .vectorSearch("byEmbedding", args.queryEmbedding, limit)
      .collect();
  },
});

/**
 * Get a memory record by its memoryId.
 */
export const getByMemoryId = query({
  args: {
    chatId: v.number(),
    memoryId: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("memoryRecords")
      .withIndex("byMemoryId", (q) => q.eq("memoryId", args.memoryId))
      .first();
  },
});

/**
 * Update lastAccessedAt and increment accessCount for a memory record.
 */
export const updateAccess = mutation({
  args: {
    chatId: v.number(),
    memoryId: v.string(),
  },
  handler: async (ctx, args) => {
    const record = await ctx.db
      .query("memoryRecords")
      .withIndex("byMemoryId", (q) => q.eq("memoryId", args.memoryId))
      .first();
    if (record) {
      await ctx.db.patch(record._id, {
        lastAccessedAt: Date.now(),
        accessCount: record.accessCount + 1,
      });
    }
  },
});
