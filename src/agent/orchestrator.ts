import type { Logger } from "../config/logger.js";
import { getEnv } from "../config/env.js";
import type { LLMProvider } from "./providers/base.js";
import { defaultSystemPrompt } from "./providers/base.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { OpenAIProvider } from "./providers/openai.js";
import type { MemoryStore } from "./memory.js";
import { InMemoryMemoryStore } from "./memory.js";
import { ToolRegistry } from "../tools/registry.js";
import { createWebSearchTool } from "../tools/web-search.js";
import { createWebFetchTool } from "../tools/web-fetch.js";
import { createWebCrawlTool } from "../tools/web-crawl.js";
import { createDraftTools } from "../tools/drafts.js";
import { createMemoryTools } from "../tools/memory.js";
import { createDigestTools } from "../tools/digest.js";
import { createTradingTools } from "../tools/trading.js";
import type { BotApiChatHistory } from "../digest/session.js";
import type { RuntimeRunResult } from "../runtimes/types.js";

/**
 * In-memory orchestrator that manages conversation state, memory,
 * tool execution, and LLM calls.
 *
 * Conversation history and memories are stored in memory only —
 * they DO NOT persist across restarts unless backed up externally.
 *
 * FIXED: The original boop-telegram orchestrator shadowed its `memory`
 * parameter with a `const memory = new InMemoryMemoryStore(logger)`
 * inside the function body. This version uses the passed-in store
 * and only falls back to a default when none is provided.
 */
export class Orchestrator {
  private provider: LLMProvider;
  private memory: MemoryStore;
  private toolRegistry: ToolRegistry;
  private logger: Logger;
  private conversationHistory: Map<string, Array<{ role: string; content: string }>> = new Map();

  constructor(logger: Logger, memory?: MemoryStore) {
    this.logger = logger.child({ component: "Orchestrator" });
    // Use the passed-in memory store — do NOT shadow it with a new one
    this.memory = memory ?? new InMemoryMemoryStore(this.logger);
    this.toolRegistry = new ToolRegistry(this.logger);
    this.provider = this.createProvider();

    this.registerDefaultTools();
  }

  /**
   * Create the LLM provider based on env var.
   */
  private createProvider(): LLMProvider {
    const env = getEnv();
    const providerType = env.LLM_PROVIDER?.toLowerCase() ?? "anthropic";

    if (providerType === "openai") {
      this.logger.info("Using OpenAI provider");
      return new OpenAIProvider(
        env.OPENAI_API_KEY!,
        env.OPENAI_MODEL ?? "gpt-4o",
        env.OPENAI_BASE_URL ?? undefined,
      );
    }

    this.logger.info("Using Anthropic provider");
    return new AnthropicProvider(
      env.ANTHROPIC_API_KEY!,
      env.ANTHROPIC_MODEL ?? "claude-sonnet-4-20250514",
    );
  }

  /**
   * Provide Bot-API transcripts derived from this orchestrator's in-memory
   * conversationHistory. Used as the historyProvider for digest tools in
   * Bot-API fallback mode (no MTProto). Public for scheduler/bot wiring.
   */
  public buildBotApiHistories(): BotApiChatHistory[] {
    const out: BotApiChatHistory[] = [];
    for (const [convId, msgs] of this.conversationHistory.entries()) {
      const [chatId] = convId.split(":");
      out.push({
        chatId: chatId ?? convId,
        title: `chat ${chatId}`,
        messages: msgs.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
      });
    }
    return out;
  }

  /**
   * Register the default tool set available to the agent.
   */
  private registerDefaultTools(): void {
    this.toolRegistry.register(createWebSearchTool(this.logger));
    this.toolRegistry.register(createWebFetchTool(this.logger));
    this.toolRegistry.register(createWebCrawlTool(this.logger));
    for (const draftTool of createDraftTools(this.logger)) {
      this.toolRegistry.register(draftTool);
    }
    for (const memoryTool of createMemoryTools(this.memory, this.logger)) {
      this.toolRegistry.register(memoryTool);
    }
    // Digest tools (MTProto preferred, Bot-API fallback via conversationHistory)
    try {
      const historyProvider = () => this.buildBotApiHistories();
      for (const t of createDigestTools(this.logger, historyProvider)) {
        this.toolRegistry.register(t);
      }
    } catch (err) {
      this.logger.warn({ err }, "Failed to register digest tools");
    }
    // Trading tools (paper/dry-run safe even without Alpaca keys)
    try {
      for (const t of createTradingTools(this.logger)) {
        this.toolRegistry.register(t);
      }
    } catch (err) {
      this.logger.warn({ err }, "Failed to register trading tools");
    }
    this.logger.debug(`Registered ${this.toolRegistry.size} default tools`);
  }

  /**
   * Process a user message: run the full agent loop with tool calls.
   */
  async processMessage(
    userId: string,
    chatId: string,
    message: string,
    systemPrompt?: string,
  ): Promise<RuntimeRunResult> {
    const convId = `${chatId}:${userId}`;
    if (!this.conversationHistory.has(convId)) {
      this.conversationHistory.set(convId, []);
    }

    const history = this.conversationHistory.get(convId)!;
    history.push({ role: "user", content: message });

    const maxCycles = 25;
    let toolCycles = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    const toolMessages: Array<{ role: string; content: string; toolCallId?: string }> = [
      ...history.map((m) => ({ role: m.role, content: m.content })),
    ];

    const effectiveSystemPrompt = systemPrompt || getEnv().SYSTEM_PROMPT || defaultSystemPrompt();

    for (let cycle = 0; cycle < maxCycles; cycle++) {
      toolCycles = cycle + 1;

      const result = await this.provider.generate({
        systemPrompt: effectiveSystemPrompt,
        messages: toolMessages.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
          toolCallId: m.toolCallId,
        })),
        tools: this.toolRegistry.getDefinitions(),
        maxTokens: 4096,
      });

      totalInputTokens += result.usage?.inputTokens ?? 0;
      totalOutputTokens += result.usage?.outputTokens ?? 0;

      if (!result.toolCalls || result.toolCalls.length === 0) {
        toolMessages.push({ role: "assistant", content: result.content });
        history.push({ role: "assistant", content: result.content });
        this.logger.debug({ cycle: cycle + 1, toolCalls: 0 }, "Agent finished (no tool calls)");
        break;
      }

      // Execute tool calls
      let assistantContent = result.content;
      for (const tc of result.toolCalls) {
        const name = tc.name;
        const args =
          typeof tc.args === "string" ? (JSON.parse(tc.args) as Record<string, unknown>) : tc.args;

        this.logger.debug({ toolName: name, args }, "Executing tool");
        const toolResult = await this.toolRegistry.execute(name, args ?? {});

        toolMessages.push({
          role: "assistant",
          content: assistantContent,
          toolCallId: tc.id,
        });
        toolMessages.push({
          role: "tool",
          content: toolResult.success ? toolResult.output : `Error: ${toolResult.error}`,
          toolCallId: tc.id,
        });
        assistantContent = "";
      }

      if (cycle === maxCycles - 1) {
        this.logger.warn({ maxCycles }, "Reached max tool cycles");
        break;
      }
    }

    // Get final response
    const finalMsg = toolMessages[toolMessages.length - 1];
    const response = finalMsg?.role === "assistant" ? finalMsg.content : "Processing complete.";

    // Cost estimate
    const providerName = getEnv().LLM_PROVIDER?.toLowerCase() ?? "anthropic";
    const inputRate = providerName === "openai" ? 2.5 : 3;
    const outputRate = providerName === "openai" ? 10 : 15;
    const estimatedCost =
      (totalInputTokens / 1_000_000) * inputRate + (totalOutputTokens / 1_000_000) * outputRate;

    return {
      response,
      toolCalls: toolMessages.filter((m) => m.role === "tool").length > 0,
      toolCycles,
      messages: toolMessages,
      estimatedCost,
      totalTokens: totalInputTokens + totalOutputTokens,
    };
  }

  /**
   * Reset conversation history for a given chat/user.
   */
  resetConversation(userId: string, chatId: string): void {
    const convId = `${chatId}:${userId}`;
    this.conversationHistory.delete(convId);
    this.logger.debug({ userId, chatId }, "Conversation reset");
  }

  getMemory(): MemoryStore {
    return this.memory;
  }

  getToolRegistry(): ToolRegistry {
    return this.toolRegistry;
  }

  getProvider(): LLMProvider {
    return this.provider;
  }
}

/**
 * Create an orchestrator instance (convenience factory).
 */
export function createOrchestrator(logger: Logger, memory?: MemoryStore): Orchestrator {
  return new Orchestrator(logger, memory);
}
