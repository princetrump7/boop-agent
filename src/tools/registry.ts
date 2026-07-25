import type { Logger } from "../config/logger.js";
import type { Tool, ToolDefinition, ToolResult } from "./types.js";

/**
 * Central registry for all tools available to the agent.
 */
export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger.child({ component: "ToolRegistry" });
  }

  /**
   * Register a tool.
   */
  register(tool: Tool): void {
    if (this.tools.has(tool.definition.name)) {
      this.logger.warn({ toolName: tool.definition.name }, "Overwriting existing tool");
    }
    this.tools.set(tool.definition.name, tool);
    this.logger.debug({ toolName: tool.definition.name }, "Tool registered");
  }

  /**
   * Get a tool by name.
   */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /**
   * Get all tool definitions (for LLM provider consumption).
   */
  getDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  /**
   * Execute a tool by name with the given arguments.
   */
  async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        toolName: name,
        args,
        output: "",
        success: false,
        error: `Unknown tool: ${name}`,
      };
    }

    try {
      this.logger.debug({ toolName: name, args }, "Executing tool");
      return await tool.execute(args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error({ toolName: name, error: message }, "Tool execution failed");
      return {
        toolName: name,
        args,
        output: "",
        success: false,
        error: message,
      };
    }
  }

  /**
   * Number of registered tools.
   */
  get size(): number {
    return this.tools.size;
  }
}
