# Boop Agent

[![CI](https://github.com/princetrump7/boop-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/princetrump7/boop-agent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Unified AI agent for Telegram — tool-calling, per-chat system prompts, memory,
multi-LLM support, and Convex persistence. Built with TypeScript, Telegraf,
and Anthropic or OpenAI-compatible providers (including OpenRouter).

## Features

| Capability        | Description                                                  |
| ----------------- | ------------------------------------------------------------ |
| 🤖 Agent chat     | Multi-step task execution with a tool-calling loop           |
| 🧠 System prompts | Per-chat persona overrides via `/system set <prompt>`        |
| 💾 Persistence    | Conversations, messages, usage, and settings in Convex       |
| 🔁 Multi-provider | Anthropic or OpenAI/OpenRouter via `LLM_PROVIDER`            |
| 🔗 Link reader   | Paste any link — articles, PDFs, docs, JSON — and Boop reads what's actually there |
| 📄 File reader   | Send a file in chat (PDF / txt / md / code / JSON) and Boop reads it |
| 🔐 Private links | Login-gated links readable via optional per-domain auth headers (`WEB_FETCH_HEADERS`) |
| 🧠 Memory         | `write_memory` / `recall` tools for short-term recall        |
| ✅ Approvals      | Human-in-the-loop confirmation for sensitive actions         |
| 🗞️ Digest         | `/digest` / `/chats` / `/chat` / `/ask` / `/join` — summarize recent chats via MTProto (GramJS) or Bot-API fallback |
| 📈 Overnight      | Paper simulator — simulated CLS (15:45) buy + OPG (19:05) ET scheduler via Yahoo Finance (no keys), DRY_RUN/PAPER, JSON WAL store |
| 🔥 folk habits    | Proactive accountability — the bot texts YOU first: `/habit gym Mon/Wed/Fri 07:00 relentless proof`, tones (gentle→relentless), proof-required check-ins, streaks + freezes, follow-up nudges, `/done` / `/missed` / `/streak` |
| 🧠 Memory graph   | Persistent people/preferences/routines/goals/contacts with relations: `/remember goal marathon : under 4h`, `/recall`, `/forget` — the agent grows it every chat |
| ☀️ Briefing       | Morning briefing + optional wind-down on schedule (`BRIEFING_HOUR`, `WIND_DOWN_HOUR`), on-demand via `/briefing` |
| 📱 WebApp         | Telegram Mini App dashboard at `/webapp` + `/api/folk/*` — habits, streaks, memory, one-tap DONE (set `PUBLIC_URL`, open with `/boop`) |

## Architecture

```
Telegram ──> Telegraf bot
              ├── auth middleware      (AUTHORIZED_USER_ID / _IDS)
              ├── command handlers     (/start, /help, /system, ...)
              ├── message handlers     (agent loop entry point)
              └── agent layer
                    ├── Orchestrator        (in-memory path)
                    ├── InteractionAgent    (Convex-backed path)
                    ├── providers           (Anthropic / OpenAI adapters)
                    └── tools               (registry + web/memory/draft tools)

Convex (optional) ──> settings, conversations, messages, usageRecords, ...
```

Two execution paths are supported:

- **Convex-backed** — when `CONVEX_URL` is set, state (settings, system
  prompts) persists across restarts via the Convex backend.
- **In-memory** — without Convex, everything is ephemeral and resets on
  restart. Per-chat system prompts fall back to an in-memory store.

> Note: conversation transcripts and memories are currently held in process
> memory in both modes. The Convex schema already includes `messages` and
> `memoryRecords` tables ready to be wired up for full persistence.

## Getting Started

### Prerequisites

- Node.js >= 20
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- An Anthropic or OpenAI API key

### Install

```bash
npm install
cp .env.example .env   # then fill in your tokens
npm run dev            # starts the bot with hot reload
```

### Environment variables

| Variable                               | Required | Description                                          |
| -------------------------------------- | -------- | ---------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`                   | ✅       | Telegram bot token from @BotFather                   |
| `AUTHORIZED_USER_ID`                   | ✅       | Your numeric Telegram ID (single-user mode)          |
| `ANTHROPIC_API_KEY`                    | one of   | Anthropic API key (when `LLM_PROVIDER=anthropic`)    |
| `OPENAI_API_KEY`                       | one of   | OpenAI / OpenRouter key (when `LLM_PROVIDER=openai`) |
| `LLM_PROVIDER`                         | no       | `anthropic` (default) or `openai`                    |
| `CONVEX_URL`                           | no       | Convex deployment URL for persistent state           |
| `CONVEX_ADMIN_KEY`                     | no       | Admin key for the bot's Convex HTTP client           |
| `SYSTEM_PROMPT`                        | no       | Default system prompt (overrides built-in persona)   |
| `TAVILY_API_KEY` / `TALORDATA_API_KEY` | no       | Web search providers                                 |
| `BOT_MODE`                             | no       | `polling` (only value — webhook not shipped)         |
| `WEB_FETCH_HEADERS`                  | no       | `{"example.com":{"Authorization":"Bearer ..."}}` — per-domain headers for private links |

## Commands

| Command                | Description                                   |
| ---------------------- | --------------------------------------------- |
| `/start`               | Welcome message                               |
| `/new`                 | Start a fresh conversation                    |
| `/model`               | Show the active provider/model                |
| `/system`              | View the effective system prompt              |
| `/system set <prompt>` | Set a custom system prompt for this chat      |
| `/system reset`        | Clear the custom prompt (back to env/default) |
| `/status`              | Show configuration and stats                  |
| `/help`                | Detailed usage guide                          |
| `/menu`                | Interactive control panel (Digest + Trading tabs) |
| `/digest [hours] [filter]` | Summarize recent chats (global + per-chat) |
| `/chats`               | List available chats                          |
| `/chat <name|#> [hours]` | Summarize one chat                          |
| `/ask <question> [hours]` | Q&A grounded in recent chat summaries        |
| `/join <invite link>`  | Join a chat by invite link (MTProto only)     |
| `/portfolio`           | Show open paper-sim positions (Yahoo Finance, no keys needed) |
| `/watchlist` / `/trading` / `/status_trading` | Trading status, exposure, windows |
| `/run_now` / `/exit_now` | Run overnight entries / exits immediately   |

> **MTProto (full dialogs) is optional.** Install the peer dep with `npm i telegram` and set `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` / `SESSION_B64` (base64 StringSession from Telethon/GramJS login). Without it, digest falls back to Bot-API transcripts derived from the bot's own conversation history.
>
> **Overnight trading is paper-simulated by default (no broker keys needed).** Prices via Yahoo Finance (no key) + optional `FINNHUB_API_KEY` fallback; mock account size via `PAPER_EQUITY` (default 100 000). Keep `DRY_RUN=true` until ready — it still simulates fills so `/run_now` works. Simulated orders use `market` + `day` at 15:45/19:05 ET and persist to `paper-broker.json`.

### Environment variables (digest + trading)

| Variable | Required | Description |
| -------- | -------- | ----------- |
| `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` / `SESSION_B64` | no | MTProto user-session (GramJS) — enables full dialog history; falls back to Bot-API when absent |
| `TIMEZONE` | no | Auto-digest timezone (default `Africa/Accra`) |
| `DEFAULT_HOURS` / `AUTO_DIGEST_HOUR` / `MAX_CHATS` / `MAX_MESSAGES` / `CHUNK_CHARS` / `MAX_MSG_CHARS` | no | Digest tuning (defaults 24h / unset / 25 / 800 / 15000 / 280) |
| `PAPER_EQUITY` | no | Mock account equity for paper simulator (default `100000`) |
| `FINNHUB_API_KEY` | no | Optional free-tier Finnhub fallback for prices (`https://finnhub.io`) — else Yahoo Finance + deterministic 80-400 fallback |
| `SYMBOLS` | no | Comma-separated watchlist (default `SPY`) |
| `EQUITY_PER_TRADE_PCT` / `MAX_TOTAL_EXPOSURE_PCT` / `MAX_POSITIONS` | no | Position sizing + caps |
| `DRY_RUN` | no | `true` (default) = log only; `false` = place orders |
| `DB_PATH` / `ENTRY_MAX_MINUTES_TO_CLOSE` / `EXIT_MIN_MINUTES_TO_OPEN` / `EXIT_MAX_MINUTES_TO_OPEN` | no | Store path (JSON, default `bot.db.json`) + entry/exit windows |

## Development

```bash
npm run dev          # run with hot reload
npm run lint         # ESLint
npm run format       # Prettier (write)
npm run typecheck    # TypeScript type checking
npm test             # Vitest unit tests
npm run build        # compile to dist/
```

The CI pipeline (`.github/workflows/ci.yml`) runs lint, format check,
typecheck, tests, and the build on Node 20 and 22 for every push and PR.

## Deployment

The repo includes a `render.yaml` for [Render](https://render.com). The
service installs dependencies, builds, and starts with long-polling. Set the
sync-false environment variables (`TELEGRAM_BOT_TOKEN`, API keys) in the
Render dashboard.

## License

[MIT](LICENSE)
