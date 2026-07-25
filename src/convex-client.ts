import { getEnv } from "./config/env.js";
import type { Logger } from "./config/logger.js";

/**
 * Minimal Convex HTTP client.
 *
 * Uses the Convex deployment URL and admin key (if available) to make
 * authenticated HTTP calls to the Convex backend. This is a thin wrapper
 * around fetch — not the full Convex SDK — for environments where we
 * don't want to import the heavy client library.
 */
export class ConvexClient {
  private url: string;
  private adminKey?: string;
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger.child({ component: "ConvexClient" });
    const env = getEnv();
    this.url = env.CONVEX_URL ?? "";
    this.adminKey = env.CONVEX_ADMIN_KEY || undefined;

    if (!this.url) {
      this.logger.warn("CONVEX_URL not set — Convex client will be unavailable");
    }
  }

  /**
   * Whether the client is configured and ready.
   */
  get isAvailable(): boolean {
    return !!this.url;
  }

  /**
   * Call a Convex mutation by name.
   */
  async mutation(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.url) throw new Error("Convex client not configured (CONVEX_URL missing)");
    return this.call("Mutation", name, args);
  }

  /**
   * Call a Convex query by name.
   */
  async query(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.url) throw new Error("Convex client not configured (CONVEX_URL missing)");
    return this.call("Query", name, args);
  }

  /**
   * Call a Convex action by name.
   */
  async action(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.url) throw new Error("Convex client not configured (CONVEX_URL missing)");
    return this.call("Action", name, args);
  }

  private async call(type: "Query" | "Mutation" | "Action", name: string, args: Record<string, unknown>): Promise<unknown> {
    const path = type === "Query"
      ? "/api/query"
      : type === "Mutation"
        ? "/api/mutation"
        : "/api/action";

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.adminKey) {
      headers["Authorization"] = `Convex ${this.adminKey}`;
    }

    this.logger.debug({ type, name, args }, "Convex call");

    const response = await fetch(`${this.url}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        path: name,
        args,
        format: "json",
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      this.logger.error({ status: response.status, body: text }, "Convex call failed");
      throw new Error(`Convex ${type} "${name}" failed: ${response.status} ${text}`);
    }

    const result = await response.json();
    return result;
  }
}

let _convexClient: ConvexClient | null = null;

/**
 * Get or create the singleton Convex client.
 */
export function getConvexClient(logger: Logger): ConvexClient {
  if (!_convexClient) {
    _convexClient = new ConvexClient(logger);
  }
  return _convexClient;
}
