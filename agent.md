# Agent Instructions — Ex Machina Repo

> **Audience**: You are an AI coding agent working on this repository. Read this before making changes.

## What This Project Is

A TypeScript multi-agent OS. Four AI agents collaborate over AgentNet (NATS messaging) to serve a human user. The system handles requests across **multiple domains** — software engineering, sports analytics, data science, business strategy — so the codebase is designed for flexibility, not a single use case.

## Tech Stack

| Layer | Tech |
|-------|------|
| Runtime | Node.js + TypeScript (ESM modules) |
| Messaging | AgentNet SDK over NATS |
| Web Search | Perplexity Search API (`POST https://api.perplexity.ai/search`) |
| Web Scraping & Browser Automation | **Playwright** (headless Chromium) |
| Shell Execution | Node.js `child_process` (`execFile` / `exec`) |
| LLM | OpenAI-compatible API (configurable per agent) |

## Project Structure

```
src/
├── agent.ts              # Core Agent class — queue, brain loop, time injection
├── config.ts             # Loads .env secrets + config/agents.yaml
├── llm.ts                # OpenAI-compatible chat completion with 120s timeout
├── main.ts               # Bootstraps all 4 agents, wires tools, shutdown handler
├── networkBridge.ts       # NATS wrapper, peer thread ID builder
├── protocol.ts            # Message envelope types (chat/task/result/error)
├── compaction.ts          # Thread compaction handler
└── tools/
    ├── registry.ts        # ToolSpec interface, registration, OpenAI schema export
    ├── orchestratorTools.ts  # assignTasks, answerDirectly
    ├── workerTools.ts     # markTaskDone, askQuestion, reportError
    ├── sharedTools.ts     # chatWithAgent, discoverAgents (all agents get these)
    ├── searchTools.ts     # Perplexity: searchWeb, deepSearch
    ├── terminalTools.ts   # Shell: 3 modes (strict/relaxed/open), factory pattern
    └── browserTools.ts    # Playwright: scrapePage, browserAction
config/
└── agents.yaml            # Per-agent model + shell_mode config (NOT secrets)
prompts/
├── base.txt               # Shared 7-section system prompt
├── orchestrator.txt       # Orchestrator-specific additions
├── agent1.txt             # Worker 1 prompt
├── agent2.txt             # Worker 2 prompt
└── agent3.txt             # Worker 3 prompt
```

## Key Patterns to Follow

### Adding a New Tool
1. Create the tool in `src/tools/` following the `ToolSpec` interface in `registry.ts`
2. Export it from the file
3. Import it in `main.ts` and add it to the relevant agent's `tools` array
4. The tool's `execute` function receives `(args, ctx)` where `ctx` has `agentId`, `bridge`, and `threadId`
5. Always return a **string** — this goes directly into the LLM's context window, so format it for readability

### Adding a New Agent
1. Add its config block to `config/agents.yaml`
2. Create its prompt file in `prompts/`
3. Instantiate it in `main.ts` using the `Agent` class
4. Add it to the `Promise.all` for start/stop

### Configuration — Never Hardcode
- **API keys** → `.env` (loaded via `dotenv`, accessed through `secrets` in `config.ts`)
- **Model routing** → `config/agents.yaml` (model name, base_url, max_tokens)
- **Agent behavior** → `config/agents.yaml` (e.g., `shell_mode: strict | relaxed | open`)
- **System prompts** → `prompts/*.txt` (plain text files, loaded at boot)

### Tool Output Format
Tool results feed directly into the LLM's context. Keep outputs:
- **Structured** with labels (e.g., `STDOUT:`, `PAGE:`, `URL:`)
- **Truncated** to a reasonable char limit (4000 for terminal, 8000 for browser)
- **Numbered** when returning lists (so the LLM can reference `[1]`, `[2]`)

### How `browserAction` Works (Example)
The `browserAction` tool allows Agent 3 to perform multi-step interactions on a single page (like logging in). It runs steps sequentially.

**Example Tool Call:**
```json
{
  "steps": [
    { "action": "goto", "url": "https://draftkings.com/bets" },
    { "action": "fill", "selector": "#email", "value": "user@email.com" },
    { "action": "click", "selector": "#login-btn" },
    { "action": "wait", "selector": ".bet-history" },
    { "action": "getText", "selector": ".bet-history" }
  ]
}
```

**Why the `wait` step is critical:**
Modern web apps (React/Vue/etc.) load data asynchronously after clicks. If you don't include a `wait` step before `getText`, you will likely extract the text of a loading spinner instead of the actual data. Always wait for the target element to appear.

## Safety Guardrails Already In Place

| Guardrail | Where | Value |
|-----------|-------|-------|
| LLM fetch timeout | `llm.ts` | 120s |
| Tool loop cap | `agent.ts` | 10 rounds max |
| Shell timeout | `terminalTools.ts` | 60s |
| Shell output cap | `terminalTools.ts` | 4000 chars |
| Browser page timeout | `browserTools.ts` | 30s |
| Browser output cap | `browserTools.ts` | 8000 chars |
| Lane queue | `agent.ts` | 1 task at a time per agent |

## Things to Watch Out For

- **`page.evaluate` in browserTools.ts** uses string-based evaluation (not arrow functions) to avoid TypeScript DOM type errors. Keep it that way.
- **`terminalTools.ts` exports a factory** (`createShellTool(mode)`), not static tool instances. The mode comes from YAML config at boot.
- **Peer thread IDs** are deterministic: `${mainThread}::${sorted(a,b)}::r${round}`. Don't change this convention.
- **Time injection** happens in `agent.ts` — every LLM call gets the current UTC time appended to the system prompt. Don't duplicate this elsewhere.
- **The shared browser instance** in `browserTools.ts` is lazy-launched and reused. `closeBrowser()` is called on SIGINT in `main.ts`.

## Latest Progress & Handoff Context (March 2026)
A new AI coding agent should review this before continuing:

1. **Fixed Orchestrator UI Reply Drops (`answerDirectly`)**: 
   Previously, the `answerDirectly` tool only returned text to the internal loop, and text was dropped if the agent called `endConversation` immediately. We fixed this by passing the `reply` function into the `ToolContext` (`src/tools/registry.ts`, `src/agent.ts`) and actively invoking `ctx.reply(createChat(args.answer))` within `src/tools/orchestratorTools.ts`.
2. **Fixed Minimax 400 Error (Agent 3)**:
   Agent 3 (using `minimax/minimax-m2.5` over the Novita API) crashed with a HTTP 400 Bad Request. We determined the model's hard maximum output tokens is 131,072. We updated `config/agents.yaml`'s `max_tokens` for Agent 3 from 131,100 down to **131,072**.
3. **Known Issue — Peer Chat Silent Failures**:
   If the Orchestrator delegates a task via `chatWithAgent` rather than `assignTasks`, and a sub-agent replies with raw conversational text without explicitly triggering `markTaskDone`, the auto-converter in `src/agent.ts` may not format the completion correctly, causing the Orchestrator to hang or exit silently expecting a specific JSON payload.
4. **Future Web UI Pivot**:
   The user wants to migrate away from the bash CLI (`src/cli.ts`) towards a Web UI integration. An `implementation_plan.md` has been drafted suggesting a minimal Express + Socket.IO gateway (`src/server.ts`) that will mirror the CLI logic, wrapped with a React frontend.
