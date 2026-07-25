import pino from "pino";
import { getEnv } from "./env.js";

/**
 * Create a configured pino logger instance.
 * Uses LOG_LEVEL from env (defaults to "info").
 * In development, pretty-prints to stdout.
 */
export function createLogger(): pino.Logger {
  const env = getEnv();
  const isDev = process.env.NODE_ENV !== "production";

  return pino({
    level: env.LOG_LEVEL,
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
