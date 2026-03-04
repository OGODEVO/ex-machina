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

## Why the Network Matters

The network is what makes multi-agent work possible.

- It lets all agents talk to each other in real time.
- It keeps conversations organized by thread.
- It makes sure tasks can be handed off and returned cleanly.

Simple flow:
1. You send a message to Agent 0 (Orchestrator).
2. Agent 0 gives work to Agent 1/2/3 when needed.
3. Workers send results back to Agent 0.
4. Agent 0 sends one final answer back to you.

Without the network, agents act like isolated bots.  
With the network, they behave like a coordinated team.

## Discovery (Why We Use It)

`discoverAgents` checks who is online and what each agent can do.

This helps because it:
- avoids assigning tasks to offline agents
- avoids sending work to the wrong agent
- makes testing and debugging faster after config/model changes

Quick test flow:
- start runtime: `npm run dev`
- open CLI: `npm run cli`
- check agents: `/agents`
- continue old convo: `/thread last`
- check delayed replies: `/history`

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
