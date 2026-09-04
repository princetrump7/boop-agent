import "dotenv/config";
import express from "express";
import { createRequire } from "node:module";
import { getEnv } from "./config/env.js";
import { createLogger } from "./config/logger.js";
import { createBot } from "./telegram/bot.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

/**
 * Boop Agent — Unified AI Agent for Telegram.
 *
 * Merged from: boop-telegram × telegram-agent
 *
 * Entry point that starts the Express health-check server and the
 * Telegram bot with long-polling.
 *
 * Provider selection (env LLM_PROVIDER):
 *   "anthropic" → Claude (default)
 *   "openai"    → GPT-4o / OpenRouter-compatible
 *
 * Persistence (env CONVEX_URL):
 *   Set → Convex-backed (persistent conversations, memories, usage)
 *   Unset → In-memory (ephemeral, reset on restart)
 */

async function main(): Promise<void> {
  const logger = createLogger();
  const env = getEnv(); // validate env vars

  logger.info("Starting Boop Agent...");
  logger.info({ provider: env.LLM_PROVIDER ?? "anthropic" }, "LLM provider");

  // Auth middleware silently drops every message from users who aren't in the
  // allow-list. With no AUTHORIZED_USER_ID / AUTHORIZED_USER_IDS configured the
  // bot looks healthy but answers nobody — surface that here so it's obvious in
  // the Render logs.
  if (!env.AUTHORIZED_USER_ID && env.AUTHORIZED_USER_IDS.length === 0) {
    logger.warn(
      "No authorized user configured (AUTHORIZED_USER_ID / AUTHORIZED_USER_IDS). " +
        "The bot will IGNORE all messages. Set AUTHORIZED_USER_ID to your Telegram " +
        "numeric ID (e.g. via @userinfobot).",
    );
  }

  // --- Create bot ---
  const botInstance = createBot(logger);

  // --- Express health-check server ---
  const app = express();
  const port = env.PORT;
  app.disable("x-powered-by");

  app.get("/health", async (_req, res) => {
    const checks: Record<string, { ok: boolean; latencyMs?: number; error?: string }> = {};
    const withTimeout = async <T>(label: string, fn: () => Promise<T>, ms = 3000) => {
      const start = Date.now();
      try {
        await Promise.race([
          fn(),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms)),
        ]);
        checks[label] = { ok: true, latencyMs: Date.now() - start };
      } catch (e) {
        checks[label] = { ok: false, latencyMs: Date.now() - start, error: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200) };
      }
    };

    await Promise.all([
      withTimeout("telegram", async () => {
        await botInstance.bot.telegram.getMe();
      }, 4000),
      ...(env.CONVEX_URL
        ? [
            withTimeout("convex", async () => {
              const url = env.CONVEX_URL.replace(/\/$/, "");
              const r = await fetch(`${url}/api/query`, { method: "GET", signal: AbortSignal.timeout(2500) }).catch(() => null);
              if (r && !r.ok && r.status !== 404 && r.status !== 405) throw new Error(`convex http ${r.status}`);
            }),
          ]
        : []),
      ...(env.ALPACA_API_KEY && env.ALPACA_API_SECRET
        ? [
            withTimeout("alpaca", async () => {
              const base = env.ALPACA_PAPER ? "https://paper-api.alpaca.markets" : "https://api.alpaca.markets";
              const r = await fetch(`${base}/v2/clock`, {
                headers: {
                  "APCA-API-KEY-ID": env.ALPACA_API_KEY!,
                  "APCA-API-SECRET-KEY": env.ALPACA_API_SECRET!,
                },
                signal: AbortSignal.timeout(2500),
              });
              if (!r.ok) throw new Error(`alpaca ${r.status}`);
            }),
          ]
        : []),
      withTimeout("llm", async () => {
        const prov = botInstance.orchestrator.getProvider();
        // tiny probe — 1 token max, fail fast
        await prov.generate({
          systemPrompt: "ping",
          messages: [{ role: "user", content: "ping" }],
          tools: [],
          maxTokens: 1,
          temperature: 0,
        });
      }, 6000),
    ]);

    const criticalFail = !checks["telegram"]?.ok;
    const anyFail = Object.values(checks).some((c) => !c.ok);
    const status = criticalFail ? "unhealthy" : anyFail ? "degraded" : "ok";
    const code = criticalFail ? 503 : anyFail ? 200 : 200;

    res.status(code).json({
      status,
      version,
      provider: env.LLM_PROVIDER ?? "anthropic",
      convex: !!env.CONVEX_URL,
      tools: botInstance.orchestrator.getToolRegistry().size,
      checks,
    });
  });

  app.get("/", (_req, res) => {
    res.json({
      name: "Boop Agent",
      version,
      description:
        "Unified AI agent for Telegram — Anthropic + OpenAI, Convex-backed persistent state, and extensible tool system.",
    });
  });

  // --- Start ---
  const server = app.listen(port, () => {
    logger.info({ port }, "Health server listening");
  });

  await botInstance.start();

  // --- Graceful shutdown ---
  const shutdown = async () => {
    logger.info("Shutting down...");
    await botInstance.stop();
    server.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
  // Let pino flush if available; then hard exit so Render restarts
  setTimeout(() => process.exit(1), 500).unref();
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
  process.exit(1);
});

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
