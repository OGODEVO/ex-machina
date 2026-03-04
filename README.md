# Ex-Machina (Agent OS on AgentNet)

Multi-agent runtime with:
- **Orchestrator (Agent 0)** for user-facing coordination
- **Worker agents (Agent 1/2/3)** for execution
- **AgentNet/NATS** for transport, threads, and request/reply messaging
- **Tool-driven behavior** (NBA data, web/search, browser automation, terminal tools)

## Architecture

- `src/main.ts`: boots Orchestrator + workers
- `src/agent.ts`: core agent loop, tool-calling, turn state machine
- `src/networkBridge.ts`: AgentNet client wrapper
- `src/tools/*`: tool implementations
- `prompts/*`: per-agent system prompts
- `config/agents.yaml`: per-agent model routing
- `src/cli.ts`: interactive CLI client (`/talk`, `/thread`, `/history`, etc.)

## Prerequisites

- Node.js 22+
- npm
- Running AgentNet/NATS stack
- API keys/tokens in `.env`

## Environment

Copy and configure:

```bash
cp .env.example .env
```

Important values:
- `NATS_URL`
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `NOVITA_API_KEY`
- `PERPLEXITY_API_KEY`
- `RSC_TOKEN` (Rolling Insights NBA DataFeeds)

## Install

```bash
npm install
```

## Run

Start agents:

```bash
npm run dev
```

Open CLI in another terminal:

```bash
npm run cli
```

## Useful CLI Commands

- `/agents` list online agents
- `/talk <agent_username>` switch target
- `/thread new|last|recent|<id>` manage thread context
- `/history` read thread history
- `/status` inspect thread status
- `/wait <ms>` set request timeout for session

## Model Routing

Edit:

```text
config/agents.yaml
```

Each agent supports:
- `model`
- `base_url`
- `max_tokens`
- optional `shell_mode` for worker shell behavior

## Notes

- Agent 2 owns NBA feed tools (`getDailySchedule`, `preGameAnalysis`, `liveGameAnalysis`).
- Orchestrator enforces delegated-result reply flow for user turns.
- Prompt files drive behavioral policies; runtime guards enforce deterministic turn completion.

## Troubleshooting

- `Authorization Violation` (NATS): verify token in `NATS_URL` matches AgentNet stack.
- Missing SDK package: ensure `agentnet-sdk` dependency path resolves.
- Timeouts: use `/history` to check for late async results.
