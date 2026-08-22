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
  WEB_FETCH_HEADERS: z.string().optional(),

  // ── Bot Mode ────────────────────────────────────────
  BOT_MODE: z.enum(["polling", "webhook"]).default("polling"),
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

/**
 * Check if the current user is authorized.
 * Supports both single-user (AUTHORIZED_USER_ID) and multi-user (AUTHORIZED_USER_IDS) config.
 */
export function isUserAuthorized(telegramId: number): boolean {
  const env = getEnv();
  if (env.AUTHORIZED_USER_IDS.length > 0) {
    return env.AUTHORIZED_USER_IDS.includes(telegramId);
  }
  if (env.AUTHORIZED_USER_ID !== undefined) {
    return telegramId === env.AUTHORIZED_USER_ID;
  }
  return false;
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
