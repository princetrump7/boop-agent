# Boop Agent

Unified AI agent for Telegram — memory, tools, multi-LLM support, and Convex
persistence. Built with TypeScript, Telegraf, and either Anthropic (Claude) or
OpenAI-compatible providers (including OpenRouter).

## Features

- 🤖 **Agent chat** — multi-step task execution with tool-calling loops
- 🧠 **System prompts** — change the agent's persona at runtime per chat:
  - `/system` — view the effective system prompt
  - `/system set <prompt>` — set a custom system prompt for this chat
  - `/system reset` — restore the environment/default prompt
  - Custom prompts persist across restarts when Convex is configured
    (`settings` table), with an in-memory fallback otherwise
- 🔍 **Web search & fetch** — Tavily, TalorData, or DuckDuckGo scraping
- 🧠 **Memory** — read/write memory tools with a Convex-backed store
- ✅ **Safe mode** — human-in-the-loop approvals for sensitive actions
- 💾 **Persistence** — conversations, messages, usage, and settings in Convex
- 🔁 **Multi-provider** — Anthropic or OpenAI/OpenRouter via `LLM_PROVIDER`

## Quick Start

```bash
npm install
cp .env.example .env   # fill in your tokens
npm run dev            # tsx watch
```

Required environment variables:

| Variable | Description |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token from @BotFather |
| `AUTHORIZED_USER_ID` | Your numeric Telegram ID (single-user mode) |
| `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` | API key for the chosen provider |

Optional but recommended:

| Variable | Description |
| --- | --- |
| `CONVEX_URL` | Convex deployment URL for persistent state |
| `CONVEX_ADMIN_KEY` | Convex admin key for the bot's HTTP client |
| `SYSTEM_PROMPT` | Default system prompt (overrides built-in persona) |
| `LLM_PROVIDER` | `anthropic` (default) or `openai` |
| `TAVILY_API_KEY` / `TALORDATA_API_KEY` | Web search providers |

## Commands

| Command | Description |
| --- | --- |
| `/start` | Welcome message |
| `/new` | Start a fresh conversation |
| `/model` | Show the active provider/model |
| `/system` | View the effective system prompt |
| `/system set <prompt>` | Set a custom system prompt for this chat |
| `/system reset` | Clear the custom prompt (back to env/default) |
| `/status` | Show configuration and stats |
| `/help` | Detailed help |

## Deployment

The repo includes a `render.yaml` for Render. The service builds with
`npm install && npm run build` and starts with `npm start` (long-polling).

## Scripts

- `npm run dev` — run with hot reload (tsx watch)
- `npm run build` — compile TypeScript to `dist/`
- `npm start` — run the compiled build
- `npm run convex:dev` / `npm run convex:deploy` — Convex local/dev deploy
