import { z } from "zod";

const logLevels = ["trace", "debug", "info", "warn", "error", "fatal"] as const;

const envSchema = z.object({
  // ── Telegram ────────────────────────────────────────
  TELEGRAM_BOT_TOKEN: z.string().min(1),

  // ── Authorization ───────────────────────────────────
  // Single user (boop-telegram compatible)
  AUTHORIZED_USER_ID: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : undefined)),
  // Multi-user (telegram-agent compatible)
  AUTHORIZED_USER_IDS: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
            .map(Number)
        : [],
    ),
  AUTHORIZED_CHAT_IDS: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
            .map(Number)
        : [],
    ),

  // ── LLM Provider ────────────────────────────────────
  LLM_PROVIDER: z.enum(["anthropic", "openai"]).default("anthropic"),

  // Anthropic
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-4-20250514"),
  MEMORY_EXTRACT_MODEL: z.string().default("claude-3-5-haiku-latest"),

  // OpenAI / OpenRouter
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-4o"),
  OPENAI_BASE_URL: z.string().optional(),

  // ── Convex (optional — in-memory fallback) ──────────
  CONVEX_URL: z.string().default(""),

  // ── System / Persona ─────────────────────────────────
  SYSTEM_PROMPT: z.string().optional(),
  UNAUTHORIZED_MESSAGE: z.string().optional(),
  CONVEX_ADMIN_KEY: z.string().optional(),

  // ── Web Search ──────────────────────────────────────
  // Tavily (preferred) — fallback to DuckDuckGo
  TAVILY_API_KEY: z.string().optional(),
  // TalorData SERP API (alternative)
  TALORDATA_API_KEY: z.string().optional(),
  WEB_SEARCH_PROVIDER: z.enum(["tavily", "talordata", "scrape"]).default("scrape"),

  // ── Web Fetch Auth (optional) ────────────────────────
  // JSON object mapping domains to extra request headers, used to read
  // private / login-gated links. Longest matching domain wins; a key of
  // "example.com" also covers its subdomains. Example:
  //   {"github.com": {"Authorization": "Bearer ghp_..."},
  //    "news.example.com": {"Cookie": "session=..."}}
  WEB_FETCH_HEADERS: z
    .string()
    .optional()
    .refine(
      (v) => {
        if (!v) return true;
        try {
          const parsed = JSON.parse(v);
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
          for (const [domain, headers] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof domain !== "string" || !domain) return false;
            if (typeof headers !== "object" || headers === null || Array.isArray(headers)) return false;
            for (const [hk, hv] of Object.entries(headers as Record<string, unknown>)) {
              if (typeof hk !== "string" || typeof hv !== "string") return false;
            }
          }
          return true;
        } catch {
          return false;
        }
      },
      { message: "WEB_FETCH_HEADERS must be JSON like {\"example.com\": {\"Authorization\": \"Bearer ...\"}} with string values" },
    ),

  // ── Digest / Summarizer (from telegram-summarizer) ─────
  // Optional MTProto user session for full-dialog access (gramjs).
  // If omitted, digest uses bot-visible history only.
  TELEGRAM_API_ID: z.coerce.number().int().positive().optional(),
  TELEGRAM_API_HASH: z.string().optional(),
  // Base64 of the Telethon .session file (SESSION_B64).
  SESSION_B64: z.string().optional(),
  // Phone number for the MTProto user session (e.g. +1234567890).
  TELEGRAM_PHONE: z.string().optional(),
  TELEGRAM_SESSION_NAME: z.string().default("tg_session"),
  TIMEZONE: z.string().default("Africa/Accra"),
  DEFAULT_HOURS: z.coerce.number().positive().default(24),
  AUTO_DIGEST_HOUR: z.coerce.number().int().min(0).max(23).optional(),
  MAX_CHATS: z.coerce.number().int().positive().default(25),
  MAX_MESSAGES: z.coerce.number().int().positive().default(800),
  CHUNK_CHARS: z.coerce.number().int().positive().default(15000),
  MAX_MSG_CHARS: z.coerce.number().int().positive().default(280),

  // ── Overnight Trading (from overnight_telegram_stock_bot) ──
  ALPACA_API_KEY: z.string().optional(),
  ALPACA_API_SECRET: z.string().optional(),
  ALPACA_PAPER: z
    .string()
    .optional()
    .default("true")
    .transform((v) => {
      const s = v.toLowerCase().trim();
      return s === "1" || s === "true" || s === "yes" || s === "on";
    }),
  SYMBOLS: z.string().default("SPY"),
  EQUITY_PER_TRADE_PCT: z.coerce.number().positive().max(100).default(10),
  MAX_TOTAL_EXPOSURE_PCT: z.coerce.number().positive().max(100).optional(),
  MAX_POSITIONS: z.coerce.number().int().positive().optional(),
  DRY_RUN: z
    .string()
    .optional()
    .default("true")
    .transform((v) => {
      const s = v.toLowerCase().trim();
      return s === "1" || s === "true" || s === "yes" || s === "on";
    }),
  DB_PATH: z.string().default("bot.db.json"),
  ENTRY_MAX_MINUTES_TO_CLOSE: z.coerce.number().positive().max(240).default(30),
  EXIT_MIN_MINUTES_TO_OPEN: z.coerce.number().positive().default(10),
  EXIT_MAX_MINUTES_TO_OPEN: z.coerce.number().positive().max(10080).default(4320),

  // ── Bot Mode ────────────────────────────────────────
  // Only polling is supported. Webhook enum removed to avoid silent misconfig
  // (bot.ts previously always called bot.launch() polling regardless of value).
  BOT_MODE: z.enum(["polling"]).default("polling"),
  PUBLIC_URL: z.string().optional(),
  WEBHOOK_SECRET: z.string().optional(),
  BOT_PORT: z.coerce.number().int().positive().default(3456),

  // ── Express ─────────────────────────────────────────
  PORT: z.coerce.number().int().positive().default(3456),

  // ── Logging ─────────────────────────────────────────
  LOG_LEVEL: z.enum(logLevels).default("info"),
});

export type EnvConfig = z.infer<typeof envSchema>;

let cachedEnv: EnvConfig | null = null;

/**
 * Parse and cache environment variables.
 * Uses Zod validation to ensure required vars are present.
 */
export function getEnv(): EnvConfig {
  if (cachedEnv) return cachedEnv;

  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Environment validation failed:\n${issues}`);
  }

  // Fail fast when the selected LLM provider's API key is missing. Without
  // this, the bot starts (and even passes health checks) but every AI call
  // fails because the provider client is built with an `undefined` key — the
  // service looks fine while actually answering nothing.
  const env = result.data;
  if (env.LLM_PROVIDER === "openai" && !env.OPENAI_API_KEY) {
    throw new Error(
      "Environment validation failed:\n  - OPENAI_API_KEY is required when LLM_PROVIDER=openai",
    );
  }
  if (env.LLM_PROVIDER === "anthropic" && !env.ANTHROPIC_API_KEY) {
    throw new Error(
      "Environment validation failed:\n  - ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic",
    );
  }

  cachedEnv = env;
  return cachedEnv;
}

/** For tests — reset the env cache so re-parsing picks up new values. */
export function resetEnvCache(): void {
  cachedEnv = null;
}

/**
 * Check if the current user is authorized.
 * Merges AUTHORIZED_USER_ID + AUTHORIZED_USER_IDS (single acts as fallback
 * even when the list is non-empty — previously the single was silently dropped).
 */
export function isUserAuthorized(telegramId: number): boolean {
  const env = getEnv();
  const allow = new Set<number>([
    ...env.AUTHORIZED_USER_IDS,
    ...(env.AUTHORIZED_USER_ID !== undefined ? [env.AUTHORIZED_USER_ID] : []),
  ]);
  if (allow.size === 0) return false;
  return allow.has(telegramId);
}

/**
 * Check if a chat is authorized (optional secondary check).
 */
export function isChatAuthorized(chatId: number): boolean {
  const env = getEnv();
  if (env.AUTHORIZED_CHAT_IDS.length === 0) return true; // allow all if not specified
  return env.AUTHORIZED_CHAT_IDS.includes(chatId);
}

/**
 * Whether Convex is configured and available.
 */
export function hasConvex(): boolean {
  const env = getEnv();
  return env.CONVEX_URL.length > 0;
}

/**
 * Whether MTProto digest sidecar is configured (gramjs).
 */
export function hasMtprotoConfig(): boolean {
  const env = getEnv();
  return Boolean(env.TELEGRAM_API_ID && env.TELEGRAM_API_HASH);
}

/**
 * Whether overnight trading (Alpaca) is configured.
 */
export function hasTradingConfig(): boolean {
  const env = getEnv();
  return Boolean(env.ALPACA_API_KEY && env.ALPACA_API_SECRET);
}
