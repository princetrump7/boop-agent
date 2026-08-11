import type { Logger } from "../config/logger.js";
import { hasConvex } from "../config/env.js";
import { getConvexClient } from "../convex-client.js";

/**
 * Per-chat system prompt store.
 *
 * Lets a chat override the system prompt (persona) at runtime:
 *   - Convex-backed when CONVEX_URL is configured (persists across restarts)
 *   - In-memory otherwise (ephemeral, reset on restart)
 *
 * The Convex implementation stores the prompt in the existing `settings`
 * table under the `systemPrompt` key, scoped by chatId.
 */
export interface SystemPromptStore {
  /** Which backend is backing the store. */
  readonly backend: "convex" | "memory";

  /** Get the custom system prompt for a chat, or undefined if not set. */
  get(chatId: string): Promise<string | undefined>;

  /** Set the custom system prompt for a chat. */
  set(chatId: string, prompt: string): Promise<void>;

  /** Remove the custom system prompt for a chat (fall back to env/default). */
  clear(chatId: string): Promise<void>;
}

/** Key used inside the Convex `settings` config map. */
const SETTINGS_KEY = "systemPrompt";

/**
 * Convex-backed implementation using the `settings` table's
 * `settings:get` / `settings:set` functions.
 */
export class ConvexSystemPromptStore implements SystemPromptStore {
  readonly backend = "convex" as const;
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger.child({ component: "ConvexSystemPromptStore" });
  }

  async get(chatId: string): Promise<string | undefined> {
    try {
      const client = getConvexClient(this.logger);
      const raw = await client.query("settings:get", {
        chatId: Number(chatId),
        key: SETTINGS_KEY,
      });
      const value = unwrapConvexResponse(raw);
      return typeof value === "string" && value.trim().length > 0 ? value : undefined;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error({ error: message }, "Failed to read system prompt from Convex");
      return undefined;
    }
  }

  async set(chatId: string, prompt: string): Promise<void> {
    const client = getConvexClient(this.logger);
    await client.mutation("settings:set", {
      chatId: Number(chatId),
      config: { [SETTINGS_KEY]: prompt },
    });
    this.logger.debug({ chatId }, "System prompt saved to Convex");
  }

  async clear(chatId: string): Promise<void> {
    const client = getConvexClient(this.logger);
    await client.mutation("settings:set", {
      chatId: Number(chatId),
      config: { [SETTINGS_KEY]: "" },
    });
    this.logger.debug({ chatId }, "System prompt cleared from Convex");
  }
}

/**
 * In-memory implementation (used when Convex is not configured).
 */
export class InMemorySystemPromptStore implements SystemPromptStore {
  readonly backend = "memory" as const;
  private prompts = new Map<string, string>();
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger.child({ component: "InMemorySystemPromptStore" });
  }

  async get(chatId: string): Promise<string | undefined> {
    return this.prompts.get(chatId);
  }

  async set(chatId: string, prompt: string): Promise<void> {
    this.prompts.set(chatId, prompt);
    this.logger.debug({ chatId }, "System prompt saved in memory");
  }

  async clear(chatId: string): Promise<void> {
    this.prompts.delete(chatId);
    this.logger.debug({ chatId }, "System prompt cleared from memory");
  }
}

/**
 * Create the appropriate store based on whether Convex is configured.
 */
export function createSystemPromptStore(logger: Logger): SystemPromptStore {
  if (hasConvex()) {
    return new ConvexSystemPromptStore(logger);
  }
  return new InMemorySystemPromptStore(logger);
}

/**
 * Unwrap the Convex HTTP response envelope.
 *
 * Queries return `{ status: "success", value: ... }`, mutations return
 * `{ status: "success", result: ... }` — fall back to the raw payload when
 * the shape is unexpected so callers always get the meaningful value.
 */
function unwrapConvexResponse(response: unknown): unknown {
  if (response && typeof response === "object") {
    const obj = response as Record<string, unknown>;
    if (obj.status === "success") {
      return obj.value ?? obj.result ?? obj;
    }
  }
  return response;
}
