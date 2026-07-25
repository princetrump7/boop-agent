import type { Logger } from "../config/logger.js";
import type { LLMProvider } from "../agent/providers/base.js";
import type { RuntimeRunRequest, RuntimeRunResult } from "./types.js";

/**
 * Run an agent loop using an OpenAI-compatible provider.
 *
 * Features:
 * - Retries on transient errors
 * - Up to `maxToolCycles` tool call iterations
 * - Cost estimation based on token usage
 * - All conversation turns preserved
 */
export async function runOpenAIAgent(
  provider: LLMProvider,
  request: RuntimeRunRequest,
  logger: Logger,
): Promise<RuntimeRunResult> {
  const log = logger.child({ component: "OpenAIRuntime" });
  const maxCycles = request.maxToolCycles ?? 25;
  const maxRetries = 3;

  const messages: Array<{ role: string; content: string; toolCallId?: string }> = [
    ...request.messages,
    { role: "user", content: request.userMessage },
  ];

  let toolCycles = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (let cycle = 0; cycle < maxCycles; cycle++) {
    toolCycles = cycle + 1;

    const llmMessages = messages.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
      toolCallId: m.toolCallId,
    }));

    // Retry loop for transient failures
    let lastError: unknown;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const result = await provider.generate({
          systemPrompt: request.systemPrompt,
          messages: llmMessages,
          tools: request.tools.length > 0 ? request.tools.map((t) => t.definition) : [],
          maxTokens: 4096,
        });

        totalInputTokens += result.usage?.inputTokens ?? 0;
        totalOutputTokens += result.usage?.outputTokens ?? 0;

        if (!result.toolCalls || result.toolCalls.length === 0) {
          // No tool calls — done
          messages.push({ role: "assistant", content: result.content });
          log.debug({ cycle: cycle + 1, toolCalls: 0 }, "Agent finished (no tool calls)");

          // Rough cost estimate (GPT-4o: $2.50/M input, $10/M output)
          const inputCost = (totalInputTokens / 1_000_000) * 2.5;
          const outputCost = (totalOutputTokens / 1_000_000) * 10;
          const estimatedCost = inputCost + outputCost;

          return {
            response: result.content,
            toolCalls: false,
            toolCycles,
            messages,
            estimatedCost,
            totalTokens: totalInputTokens + totalOutputTokens,
          };
        }

        // Add assistant message with tool calls
        let assistantContent = result.content;

        for (const tc of result.toolCalls) {
          const tool = request.tools.find((t) => t.definition.name === tc.name);
          if (tool) {
            try {
              log.debug({ toolName: tc.name, args: tc.args }, "Executing tool");
              const toolOutput = await tool.execute(typeof tc.args === "string" ? JSON.parse(tc.args) as Record<string, unknown> : tc.args);
              messages.push({
                role: "assistant",
                content: assistantContent,
                toolCallId: tc.id,
              });
              messages.push({
                role: "tool",
                content: toolOutput,
                toolCallId: tc.id,
              });
            } catch (err) {
              const errorMsg = err instanceof Error ? err.message : String(err);
              log.error({ toolName: tc.name, error: errorMsg }, "Tool execution threw");
              messages.push({
                role: "assistant",
                content: assistantContent,
                toolCallId: tc.id,
              });
              messages.push({
                role: "tool",
                content: `Error: ${errorMsg}`,
                toolCallId: tc.id,
              });
            }
          } else {
            log.warn({ toolName: tc.name }, "Unknown tool called");
            messages.push({
              role: "assistant",
              content: assistantContent,
              toolCallId: tc.id,
            });
            messages.push({
              role: "tool",
              content: `Unknown tool: ${tc.name}`,
              toolCallId: tc.id,
            });
          }
          assistantContent = "";
        }

        // Break out of retry loop — success
        break;
      } catch (err) {
        lastError = err;
        log.error({ attempt: attempt + 1, error: err }, "OpenAI generation attempt failed");
        if (attempt < maxRetries - 1) {
          const delay = Math.pow(2, attempt) * 1000;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    // If all retries failed, throw
    if (lastError) {
      throw lastError;
    }

    if (cycle === maxCycles - 1) {
      log.warn({ maxCycles }, "Reached max tool cycles");
      break;
    }
  }

  const finalMessage = messages[messages.length - 1];
  const response = finalMessage?.role === "assistant" ? finalMessage.content : "Processing complete.";

  const inputCost = (totalInputTokens / 1_000_000) * 2.5;
  const outputCost = (totalOutputTokens / 1_000_000) * 10;
  const estimatedCost = inputCost + outputCost;

  return {
    response,
    toolCalls: toolCycles > 1 || (messages.filter((m) => m.role === "tool").length > 0),
    toolCycles,
    messages,
    estimatedCost,
    totalTokens: totalInputTokens + totalOutputTokens,
  };
}
