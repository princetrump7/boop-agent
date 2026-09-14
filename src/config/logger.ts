import pino from "pino";
import { getEnv } from "./env.js";

/**
 * Create a configured pino logger instance.
 * Uses LOG_LEVEL from env (defaults to "info").
 * In development, pretty-prints to stdout.
 */
const REDACT_PATHS = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_API_HASH",
  "SESSION_B64",
  "FINNHUB_API_KEY",
  "TRADIER_API_KEY",
  "TRADIER_ACCOUNT_ID",
  "ALPACA_API_SECRET",
  "ALPACA_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "authorization",
  "Authorization",
  "cookie",
  "Cookie",
];

export function createLogger(): pino.Logger {
  const env = getEnv();
  const isDev = process.env.NODE_ENV !== "production";

  return pino({
    level: env.LOG_LEVEL,
    redact: { paths: REDACT_PATHS, remove: true },
    ...(isDev && {
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:standard",
          ignore: "pid,hostname",
        },
      },
    }),
  });
}

export type Logger = pino.Logger;
