import OpenAI from "openai";
import type {
  LLMProvider,
  LLMMessage,
  GenerateParams,
  GenerateResponse,
  ToolCallResult,
} from "./base.js";
import type { ToolDefinition } from "../../tools/types.js";

/**
 * OpenAI provider implementation.
 * Supports OpenAI and OpenRouter (via OPENAI_BASE_URL).
 */
export class OpenAIProvider implements LLMProvider {
  readonly name = "openai";
  private client: OpenAI;
  private defaultModel: string;

  constructor(apiKey: string, defaultModel = "gpt-4o", baseURL?: string) {
    this.client = new OpenAI({
      apiKey,
      baseURL: baseURL ?? undefined,
    });
    this.defaultModel = defaultModel;
  }

  async generate(params: GenerateParams): Promise<GenerateResponse> {
    const messages = this.convertMessages(params.messages, params.systemPrompt);

    const tools =
      params.tools.length > 0 ? params.tools.map((t) => this.convertTool(t)) : undefined;

    const response = await this.client.chat.completions.create({
      model: this.defaultModel,
      messages,
      tools,
      max_tokens: params.maxTokens ?? 4096,
      temperature: params.temperature ?? 0.7,
    });

    return this.convertResponse(response);
  }

  async *generateStream(
    params: GenerateParams,
  ): AsyncIterable<
    { type: "text"; content: string } | { type: "tool_use"; toolCall: ToolCallResult }
  > {
    const messages = this.convertMessages(params.messages, params.systemPrompt);
    const tools =
      params.tools.length > 0 ? params.tools.map((t) => this.convertTool(t)) : undefined;

    const stream = await this.client.chat.completions.create({
      model: this.defaultModel,
      messages,
      tools,
      max_tokens: params.maxTokens ?? 4096,
      temperature: params.temperature ?? 0.7,
      stream: true,
    });

    let pendingToolCalls: Map<number, { name: string; args: string; id: string }> = new Map();

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        yield { type: "text", content: delta.content };
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const index = tc.index;
          if (!pendingToolCalls.has(index)) {
            pendingToolCalls.set(index, {
              name: tc.function?.name ?? "",
              args: tc.function?.arguments ?? "",
              id: tc.id ?? "",
            });
          } else {
            const existing = pendingToolCalls.get(index)!;
            if (tc.function?.arguments) {
              existing.args += tc.function.arguments;
            }
            if (tc.function?.name) {
              existing.name += tc.function.name;
            }
            if (tc.id) {
              existing.id = tc.id;
            }
          }
        }
      }

      if (chunk.choices?.[0]?.finish_reason === "tool_calls") {
        for (const [, call] of pendingToolCalls) {
          yield { type: "tool_use", toolCall: call };
        }
        pendingToolCalls = new Map();
      }
    }
  }

  private convertMessages(
    messages: LLMMessage[],
    systemPrompt: string,
  ): OpenAI.Chat.ChatCompletionMessageParam[] {
    const result: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
    ];

    for (const msg of messages) {
      if (msg.role === "system") continue;

      if (msg.role === "tool") {
        result.push({
          role: "tool",
          tool_call_id: msg.toolCallId ?? "",
          content: msg.content,
        });
      } else if (msg.role === "assistant" && msg.toolCallId) {
        result.push({
          role: "assistant",
          content: msg.content,
          tool_calls: [
            {
              id: msg.toolCallId,
              type: "function",
              function: {
                name: msg.toolName ?? "",
                arguments: msg.content || "{}",
              },
            },
          ],
        });
      } else {
        result.push({
          role: msg.role === "assistant" ? "assistant" : "user",
          content: msg.content,
        });
      }
    }

    return result;
  }

  private convertTool(tool: ToolDefinition): OpenAI.Chat.ChatCompletionTool {
    return {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema as Record<string, unknown>,
      },
    };
  }

  private convertResponse(response: OpenAI.Chat.Completions.ChatCompletion): GenerateResponse {
    const choice = response.choices[0];
    const message = choice?.message;

    const content = message?.content ?? "";
    const toolCalls: ToolCallResult[] = [];

    if (message?.tool_calls) {
      for (const tc of message.tool_calls) {
        toolCalls.push({
          id: tc.id,
          name: tc.function.name,
          args: tc.function.arguments,
        });
      }
    }

    return {
      content,
      toolCalls,
      finishReason:
        choice?.finish_reason === "stop"
          ? "stop"
          : choice?.finish_reason === "tool_calls"
            ? "tool_use"
            : choice?.finish_reason === "length"
              ? "max_tokens"
              : "stop",
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
    };
  }
}
