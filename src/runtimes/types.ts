import type { ToolDefinition } from "../tools/types.js";

/**
 * A runtime tool — a tool definition with an execute function.
 */
export interface RuntimeTool {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>): Promise<string>;
}

/**
 * Request to run an agent.
 */
export interface RuntimeRunRequest {
  /** The system prompt/persona */
  systemPrompt: string;
  /** The conversation history (already formatted messages) */
  messages: Array<{ role: string; content: string; toolCallId?: string }>;
  /** The new user message to respond to */
  userMessage: string;
  /** Tools available to the agent */
  tools: RuntimeTool[];
  /** Max tool call iterations before yielding control back */
  maxToolCycles?: number;
}

/**
 * Result from running an agent.
 */
export interface RuntimeRunResult {
  /** The agent's response text */
  response: string;
  /** Whether the agent made any tool calls */
  toolCalls: boolean;
  /** Number of tool call cycles used */
  toolCycles: number;
  /** Full conversation history including assistant turns */
  messages: Array<{ role: string; content: string; toolCallId?: string }>;
  /** Estimated cost in USD */
  estimatedCost?: number;
  /** Approximate total tokens used */
  totalTokens?: number;
}
