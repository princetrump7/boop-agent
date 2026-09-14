import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Merged schema combining telegram-agent's 7 tables and boop-telegram's users table.
 *
 * Tables:
 *  - users:           authorized users + active status
 *  - conversations:   per-chat metadata (title, model override, system prompt override)
 *  - messages:        all chat messages, linked by turnId
 *  - memoryRecords:   vector-searchable memories with decay tiers
 *  - agents:          agent run tracking
 *  - agentLogs:       per-step tool-call logs
 *  - usageRecords:    per-chat token usage & cost
 *  - drafts:          structured-output drafts (save/confirm/reject)
 */
export default defineSchema({
  users: defineTable({
    telegramId: v.number(),
    username: v.optional(v.string()),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    isActive: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("byTelegramId", ["telegramId"]),

  conversations: defineTable({
    telegramId: v.number(),
    chatId: v.number(),
    title: v.optional(v.string()),
    model: v.optional(v.string()),
    systemPrompt: v.optional(v.string()),
    lastTurnId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("byTelegramId", ["telegramId"])
    .index("byUpdatedAt", ["updatedAt"]),

  messages: defineTable({
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
    createdAt: v.number(),
  })
    .index("byChatId", ["chatId"])
    .index("byChatIdTurnId", ["chatId", "turnId"]),

  memoryRecords: defineTable({
    chatId: v.number(),
    telegramId: v.optional(v.number()),
    memoryId: v.string(),
    content: v.string(),
    category: v.optional(v.string()),
    importance: v.optional(v.number()),
    tier: v.string(), // "short" | "long" | "permanent"
    decayRate: v.number(),
    decayStartedAt: v.number(),
    lastAccessedAt: v.number(),
    accessCount: v.number(),
    expiresAt: v.optional(v.number()),
    embedding: v.optional(v.array(v.float64())),
    createdAt: v.number(),
  })
    .index("byChatId", ["chatId"])
    .index("byMemoryId", ["memoryId"])
    .vectorIndex("byEmbedding", {
      vectorField: "embedding",
      dimensions: 1536,
      filterFields: ["chatId"],
    }),

  agents: defineTable({
    chatId: v.number(),
    turnId: v.string(),
    provider: v.string(),
    model: v.string(),
    status: v.string(),
    startedAt: v.number(),
    completedAt: v.optional(v.number()),
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    error: v.optional(v.string()),
  }).index("byChatId", ["chatId"]),

  agentLogs: defineTable({
    chatId: v.number(),
    turnId: v.string(),
    agentId: v.optional(v.string()),
    step: v.number(),
    type: v.string(), // "tool_call" | "tool_result" | "tool_error" | "llm_call" | "error"
    toolName: v.optional(v.string()),
    input: v.optional(v.string()),
    output: v.optional(v.string()),
    duration: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("byChatId", ["chatId"])
    .index("byTurnId", ["turnId"]),

  usageRecords: defineTable({
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
    createdAt: v.number(),
  })
    .index("byChatId", ["chatId"])
    .index("byDate", ["date", "chatId"]),

  settings: defineTable({
    chatId: v.number(),
    config: v.object({}),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("byChatId", ["chatId"]),

  drafts: defineTable({
    chatId: v.number(),
    turnId: v.optional(v.string()),
    title: v.string(),
    content: v.string(),
    type: v.optional(v.string()),
    status: v.string(), // "draft" | "confirmed" | "rejected"
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("byChatIdStatus", ["chatId", "status"])
    .index("byTurnId", ["turnId"]),

  // ── folk engine (proactive accountability — mirrors folk.db.json) ──
  habits: defineTable({
    habitId: v.string(),
    chatId: v.number(),
    telegramId: v.optional(v.number()),
    name: v.string(),
    days: v.array(v.number()),
    times: v.array(v.string()),
    tone: v.string(), // "gentle" | "steady" | "firm" | "relentless"
    proofRequired: v.boolean(),
    paused: v.boolean(),
    streak: v.number(),
    longestStreak: v.number(),
    freezes: v.number(),
    lastCheckinDate: v.optional(v.string()),
    totalCheckins: v.number(),
    totalMisses: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("byChatId", ["chatId"])
    .index("byHabitId", ["habitId"]),

  habitCheckins: defineTable({
    checkinId: v.string(),
    habitId: v.string(),
    chatId: v.number(),
    date: v.string(),
    scheduledTime: v.string(),
    status: v.string(), // "pending" | "done" | "missed" | "skipped"
    proof: v.optional(v.string()),
    sentAt: v.number(),
    respondedAt: v.optional(v.number()),
    followups: v.number(),
  })
    .index("byChatId", ["chatId"])
    .index("byHabitId", ["habitId"]),

  memoryNodes: defineTable({
    nodeId: v.string(),
    chatId: v.number(),
    kind: v.string(), // "person" | "preference" | "routine" | "goal" | "contact" | "fact"
    label: v.string(),
    detail: v.string(),
    importance: v.number(),
    accessCount: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("byChatId", ["chatId"])
    .index("byNodeId", ["nodeId"]),

  memoryEdges: defineTable({
    edgeId: v.string(),
    chatId: v.number(),
    fromId: v.string(),
    toId: v.string(),
    relation: v.string(),
    createdAt: v.number(),
  }).index("byChatId", ["chatId"]),
});
