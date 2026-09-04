import type { Logger } from "../../config/logger.js";
import { getEnv } from "../../config/env.js";
import type { LLMProvider } from "./base.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";

/**
 * Create an LLM provider from env (shared by tools + pipeline).
 * Used by digest tools and other provider-direct callers that are outside
 * Orchestrator/InteractionAgent's private createProvider().
 */
export function createLLMProviderFromEnv(logger?: Logger): LLMProvider {
  const env = getEnv();
  const providerType = (env.LLM_PROVIDER ?? "anthropic").toLowerCase();
  if (providerType === "openai") {
    logger?.debug("Factory: using OpenAI provider");
    return new OpenAIProvider(
      env.OPENAI_API_KEY!,
      env.OPENAI_MODEL ?? "gpt-4o",
      env.OPENAI_BASE_URL ?? undefined,
    );
  }
  logger?.debug("Factory: using Anthropic provider");
  return new AnthropicProvider(
    env.ANTHROPIC_API_KEY!,
    env.ANTHROPIC_MODEL ?? "claude-sonnet-4-20250514",
  );
}
