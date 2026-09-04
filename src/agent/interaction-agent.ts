import type { Logger } from "../config/logger.js";
import { getEnv } from "../config/env.js";
import type { LLMProvider } from "./providers/base.js";
import { defaultSystemPrompt } from "./providers/base.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { OpenAIProvider } from "./providers/openai.js";
import { ToolRegistry } from "../tools/registry.js";
import { createWebSearchTool } from "../tools/web-search.js";
import { createWebFetchTool } from "../tools/web-fetch.js";
import { createWebCrawlTool } from "../tools/web-crawl.js";
import { createDraftTools } from "../tools/drafts.js";
import { createMemoryTools } from "../tools/memory.js";
import { createDigestTools } from "../tools/digest.js";
import { createTradingTools } from "../tools/trading.js";
import { runClaudeAgent } from "../runtimes/claude.js";
import { runOpenAIAgent } from "../runtimes/openai.js";
import type { RuntimeRunResult } from "../runtimes/types.js";
import type { ToolDefinition } from "../tools/types.js";
import type { MemoryStore } from "./memory.js";
import { InMemoryMemoryStore } from "./memory.js";

/**
 * Convex-backed agent.
 *
 * Uses Convex for persistent storage of conversations, messages, memories,
 * and usage records. Falls back to in-memory if Convex is unavailable.
 *
 * When CONVEX_URL is set, the agent persists state. When not set,
 * state lives only in memory for the duration of the session.
 */
export class InteractionAgent {
  private provider: LLMProvider;
  private toolRegistry: ToolRegistry;
  private memory: MemoryStore;
  private logger: Logger;
  private convexUrl?: string;
  private historyProvider?: () => import("../digest/session.js").BotApiChatHistory[] | Promise<import("../digest/session.js").BotApiChatHistory[]>;

  constructor(logger: Logger, historyProvider?: () => import("../digest/session.js").BotApiChatHistory[] | Promise<import("../digest/session.js").BotApiChatHistory[]>) {
    this.logger = logger.child({ component: "InteractionAgent" });
    this.toolRegistry = new ToolRegistry(this.logger);
    this.memory = new InMemoryMemoryStore(this.logger);
    this.provider = this.createProvider();
    this.convexUrl = getEnv().CONVEX_URL || undefined;
    this.historyProvider = historyProvider;

    this.registerDefaultTools();
  }

  setHistoryProvider(provider: () => import("../digest/session.js").BotApiChatHistory[] | Promise<import("../digest/session.js").BotApiChatHistory[]>): void {
    this.historyProvider = provider;
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
   * Register the default tool set.
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
    // Digest tools: Convex-backed histories supplied via injected provider or fallback to empty
    try {
      for (const t of createDigestTools(this.logger, this.historyProvider)) {
        this.toolRegistry.register(t);
      }
    } catch (err) {
      this.logger.warn({ err }, "Failed to register digest tools (InteractionAgent)");
    }
    // Trading tools
    try {
      for (const t of createTradingTools(this.logger)) {
        this.toolRegistry.register(t);
      }
    } catch (err) {
      this.logger.warn({ err }, "Failed to register trading tools (InteractionAgent)");
    }
    this.logger.debug(`Registered ${this.toolRegistry.size} default tools`);
  }

  /**
   * Process a user message through the agent loop.
   *
   * With Convex: persists conversation, messages, and usage to the DB.
   * Without Convex: runs entirely in memory (delegates to runtimes).
   */
  async processMessage(
    chatId: string,
    userId: string,
    message: string,
    conversationHistory: Array<{ role: string; content: string; toolCallId?: string }> = [],
    systemPrompt?: string,
  ): Promise<RuntimeRunResult> {
    const env = getEnv();
    const effectiveSystemPrompt = systemPrompt || env.SYSTEM_PROMPT || defaultSystemPrompt();

    const runtimeTools: Array<{
      definition: ToolDefinition;
      execute(args: Record<string, unknown>): Promise<string>;
    }> = this.toolRegistry.getDefinitions().map((def) => ({
      definition: def,
      execute: async (args: Record<string, unknown>) => {
        const result = await this.toolRegistry.execute(def.name, args);
        return result.success ? result.output : `Error: ${result.error}`;
      },
    }));

    const providerType = env.LLM_PROVIDER?.toLowerCase() ?? "anthropic";

    if (providerType === "openai") {
      return runOpenAIAgent(
        this.provider,
        {
          systemPrompt: effectiveSystemPrompt,
          messages: conversationHistory,
          userMessage: message,
          tools: runtimeTools,
          maxToolCycles: 25,
        },
        this.logger,
      );
    }

    return runClaudeAgent(
      this.provider,
      {
        systemPrompt: effectiveSystemPrompt,
        messages: conversationHistory,
        userMessage: message,
        tools: runtimeTools,
        maxToolCycles: 25,
      },
      this.logger,
    );
  }

  /**
   * Get the current provider instance.
   */
  getProvider(): LLMProvider {
    return this.provider;
  }

  /**
   * Get the tool registry for registering additional tools.
   */
  getToolRegistry(): ToolRegistry {
    return this.toolRegistry;
  }
}
