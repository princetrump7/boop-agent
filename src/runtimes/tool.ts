import type { JSONSchema7 } from "json-schema";
import type { RuntimeTool } from "./types.js";
import type { ToolDefinition } from "../tools/types.js";

/**
 * Helper to define a runtime tool from a Zod-like schema object.
 * Accepts a plain object with JSON Schema-like properties.
 */
export function defineRuntimeTool(
  name: string,
  description: string,
  inputSchema: JSONSchema7,
  execute: (args: Record<string, unknown>) => Promise<string>,
): RuntimeTool {
  const definition: ToolDefinition = {
    name,
    description,
    inputSchema,
  };

  return { definition, execute };
}

/**
 * Convert a RuntimeTool to an internal Tool (for use with ToolRegistry).
 */
export function runtimeToolToTool(runtimeTool: RuntimeTool): {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>): Promise<{ toolName: string; args: Record<string, unknown>; output: string; success: boolean; error?: string }>;
} {
  return {
    definition: runtimeTool.definition,
    async execute(args: Record<string, unknown>) {
      try {
        const output = await runtimeTool.execute(args);
        return { toolName: runtimeTool.definition.name, args, output, success: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { toolName: runtimeTool.definition.name, args, output: "", success: false, error: message };
      }
    },
  };
}
