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
| `BOT_MODE`                             | no       | `polling` (default) or `webhook`                     |

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
