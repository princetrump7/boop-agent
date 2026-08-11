import Anthropic from "@anthropic-ai/sdk";
import type {
  LLMProvider,
  LLMMessage,
  GenerateParams,
  GenerateResponse,
  ToolCallResult,
} from "./base.js";
import type { ToolDefinition } from "../../tools/types.js";

/**
 * Anthropic provider implementation.
 * Converts our internal types to Anthropic SDK types and back.
 */
export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  private client: Anthropic;
  private defaultModel: string;

  constructor(apiKey: string, defaultModel = "claude-sonnet-4-20250514") {
    this.client = new Anthropic({ apiKey });
    this.defaultModel = defaultModel;
  }

  async generate(params: GenerateParams): Promise<GenerateResponse> {
    const systemMessage = params.systemPrompt;

    const messages = this.convertMessages(params.messages);

    const tools = params.tools.length > 0
      ? params.tools.map((t) => this.convertTool(t))
      : undefined;

    const response = await this.client.messages.create({
      model: this.defaultModel,
      max_tokens: params.maxTokens ?? 4096,
      system: systemMessage,
      messages,
      tools,
      temperature: params.temperature ?? 0.7,
    });

    return this.convertResponse(response);
  }

  async *generateStream(
    params: GenerateParams
  ): AsyncIterable<{ type: "text"; content: string } | { type: "tool_use"; toolCall: ToolCallResult }> {
    const model = this.defaultModel;
    const messages = this.convertMessages(params.messages);
    const tools = params.tools.length > 0
      ? params.tools.map((t) => this.convertTool(t))
      : undefined;

    const stream = await this.client.messages.create({
      model,
      max_tokens: params.maxTokens ?? 4096,
      system: params.systemPrompt,
      messages,
      tools,
      temperature: params.temperature ?? 0.7,
      stream: true,
    });

    for await (const chunk of stream) {
      if (chunk.type === "content_block_delta" && chunk.delta.type === "text_delta") {
        yield { type: "text", content: chunk.delta.text };
      } else if (
        chunk.type === "content_block_start" &&
        chunk.content_block.type === "tool_use"
      ) {
        yield {
          type: "tool_use",
          toolCall: {
            id: chunk.content_block.id,
            name: chunk.content_block.name,
            args: JSON.stringify(chunk.content_block.input),
          },
        };
      }
    }
  }

  private convertMessages(messages: LLMMessage[]): Anthropic.MessageParam[] {
    const result: Anthropic.MessageParam[] = [];

    for (const msg of messages) {
      if (msg.role === "system") continue; // system goes in top-level param

      if (msg.role === "tool") {
        // tool_result content block
        const lastMsg = result[result.length - 1];
        if (lastMsg && lastMsg.role === "user") {
          // Append to existing user message
          lastMsg.content = [
            ...(Array.isArray(lastMsg.content) ? lastMsg.content : [{ type: "text" as const, text: lastMsg.content as string }]),
            {
              type: "tool_result" as const,
              tool_use_id: msg.toolCallId ?? "",
              content: msg.content,
            },
          ];
        } else {
          result.push({
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: msg.toolCallId ?? "",
                content: msg.content,
              },
            ],
          });
        }
      } else if (msg.role === "assistant" && msg.toolCallId) {
        // Tool-use message (assistant requesting a tool)
        const content: Anthropic.ContentBlock[] = [{ type: "text", text: msg.content, citations: null }];
        if (msg.toolName && msg.toolCallId) {
          content.push({
            type: "tool_use",
            id: msg.toolCallId,
            name: msg.toolName!,
            input: msg.content ? { query: msg.content } : {},
          });
        }
        result.push({ role: "assistant", content });
      } else {
        result.push({
          role: msg.role === "assistant" ? "assistant" : "user",
          content: msg.content,
        });
      }
    }

    return result;
  }

  private convertTool(tool: ToolDefinition): Anthropic.Tool {
    return {
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
    };
  }

  private convertResponse(response: Anthropic.Message): GenerateResponse {
    let content = "";
    const toolCalls: ToolCallResult[] = [];

    for (const block of response.content) {
      if (block.type === "text") {
        content += block.text;
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          name: block.name,
          args: JSON.stringify(block.input),
        });
      }
    }

    return {
      content,
      toolCalls,
      finishReason: response.stop_reason === "end_turn"
        ? "stop"
        : response.stop_reason === "tool_use"
          ? "tool_use"
          : response.stop_reason === "max_tokens"
            ? "max_tokens"
            : "stop",
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }
}
