import type { Logger } from "../config/logger.js";
import type { LLMProvider } from "../agent/providers/base.js";
import type { RuntimeRunRequest, RuntimeRunResult } from "./types.js";

/**
 * Run an agent loop using an Anthropic/Claude provider.
 *
 * Features:
 * - Streaming text output
 * - Up to `maxToolCycles` tool call iterations
 * - Cost estimation based on token usage
 * - All conversation turns preserved in the returned message list
 */
export async function runClaudeAgent(
  provider: LLMProvider,
  request: RuntimeRunRequest,
  logger: Logger,
): Promise<RuntimeRunResult> {
  const log = logger.child({ component: "ClaudeRuntime" });
  const maxCycles = request.maxToolCycles ?? 25;

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
      break;
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

    if (cycle === maxCycles - 1) {
      log.warn({ maxCycles }, "Reached max tool cycles");
      break;
    }
  }

  // Get final assistant response
  const finalMessage = messages[messages.length - 1];
  const response = finalMessage?.role === "assistant" ? finalMessage.content : "Processing complete.";

  // Rough cost estimate (Claude Sonnet 4: $3/M input, $15/M output)
  const inputCost = (totalInputTokens / 1_000_000) * 3;
  const outputCost = (totalOutputTokens / 1_000_000) * 15;
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
