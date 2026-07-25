import type { JSONSchema7 } from "json-schema";

/**
 * A tool definition for LLM function calling.
 * inputSchema is a JSON Schema object describing the expected parameters.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JSONSchema7;
}

/**
 * Result from executing a tool.
 */
export interface ToolResult {
  /** The tool that was called */
  toolName: string;
  /** The parsed arguments */
  args: Record<string, unknown>;
  /** The output content (stringified) */
  output: string;
  /** Whether the tool succeeded */
  success: boolean;
  /** Optional error message */
  error?: string;
}

/**
 * A callable tool with its definition and execute function.
 */
export interface Tool {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>): Promise<ToolResult>;
}
