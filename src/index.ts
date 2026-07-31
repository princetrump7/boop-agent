import "dotenv/config";
import express from "express";
import { getEnv } from "./config/env.js";
import { createLogger } from "./config/logger.js";
import { createBot } from "./telegram/bot.js";

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

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      provider: env.LLM_PROVIDER ?? "anthropic",
      convex: !!env.CONVEX_URL,
      tools: botInstance.orchestrator.getToolRegistry().size,
    });
  });

  app.get("/", (_req, res) => {
    res.json({
      name: "Boop Agent",
      version: "1.0.0",
      description: "Unified AI agent for Telegram — Anthropic + OpenAI, Convex-backed persistent state, and extensible tool system.",
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

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
