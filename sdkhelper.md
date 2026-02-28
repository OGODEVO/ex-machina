# AgentNet TS SDK Bridge (LLM Handoff)

This document is the handoff spec for building a TypeScript agent system that uses AgentNet as its network layer.

## What this repo provides

AgentNet (this repo) is the **network + protocol + persistence** layer:

- NATS transport (`account.<account_id>.inbox`, registry RPC subjects)
- registry identity/discovery/profile/thread APIs
- thread accounting/status (`ok` / `warn` / `needs_compaction`)
- compaction system event (`payload.type = "compaction_required"`)
- durable storage (Postgres)

This repo is **not** your agent operating system.  
Your TS repo should own:

- orchestration/planning/tool use
- long-term memory strategy
- model routing
- product behavior

## TS SDK location

Current TS SDK scaffold is in:

- `ts-sdk/agentnet-sdk`

Main files:

- `ts-sdk/agentnet-sdk/src/client.ts`
- `ts-sdk/agentnet-sdk/src/types.ts`
- `ts-sdk/agentnet-sdk/src/subjects.ts`
- `ts-sdk/agentnet-sdk/src/events.ts`

## Critical transport rule

Use **NATS directly**, not HTTPS, for AgentNet traffic.

Example local URL:

`nats://agentnet_secret_token@localhost:4222`

## API contract your TS agent should rely on

### Lifecycle

- `connect()`
- `start()` (connect + register + heartbeat + receipt setup)
- `close()`

### Messaging

- `send(to, payload, options?)`
- `sendToAccount(accountId, payload, options?)`
- `sendToUsername(username, payload, options?)`
- `request(to, payload, options?)`
- `requestAccount(accountId, payload, options?)`
- `requestUsername(username, payload, options?)`
- `subscribeInbox(handler)`

### Registry/discovery

- `listOnlineAgents()`
- `resolveAccountByUsername(username)`
- `searchProfiles(options?)`
- `getProfile({ accountId? | username? })`

### Threads/debug/ops

- `threadStatus(threadId, options?)`
- `listThreads(options?)`
- `getThreadMessages(threadId, options?)`
- `searchMessages(options?)`

### Event parsing helpers

- `isCompactionRequired(source)`
- `parseCompactionRequired(source)`

## Thread model (important)

Every message should include:

- `thread_id`
- `trace_id`
- optional `parent_message_id`

If omitted, SDK defaults to `thread_<trace_id>`.  
For product stability, your agent OS should always set `thread_id` explicitly.

## Compaction model

Network does not summarize thread content itself.  
Network emits a **system event** when thread exceeds limits:

- `kind = "system"`
- `payload.type = "compaction_required"`

Your TS agent must:

1. parse event (`parseCompactionRequired`)
2. generate checkpoint summary
3. send checkpoint message on same thread:
   - `payload.type = "checkpoint"`
   - `covers_start`
   - `covers_end`
   - summary body

## Minimal integration example

```ts
import { AgentNetClient, parseCompactionRequired } from "agentnet-sdk";

const sdk = new AgentNetClient({
  natsUrl: "nats://agentnet_secret_token@localhost:4222",
  agentId: "orchestrator_1",
  name: "Orchestrator 1",
  username: "orchestrator_1",
  capabilities: ["mesh.agent"],
});

await sdk.start();

await sdk.subscribeInbox(async (msg, ctx) => {
  const compaction = parseCompactionRequired(msg);
  if (compaction) {
    // TODO: fetch thread messages, summarize, then send checkpoint
    await sdk.sendToAccount(msg.to_account_id!, {
      type: "checkpoint",
      summary_version: "v1",
      covers_start: Math.max(1, compaction.latest_checkpoint_end + 1),
      covers_end: compaction.message_count - 24,
      summary: "checkpoint summary text",
    }, {
      kind: "system",
      threadId: compaction.thread_id,
      parentMessageId: msg.message_id,
      requireDeliveryAck: false,
    });
    return;
  }

  // normal agent logic
  const text = typeof msg.payload === "object" && msg.payload && "text" in (msg.payload as Record<string, unknown>)
    ? String((msg.payload as Record<string, unknown>).text ?? "")
    : "";

  await ctx.reply({ text: `received: ${text}` }, { kind: "reply" });
});
```

## Recommended wrapper layer in your TS repo

Create your own `networkBridge.ts` around SDK so the rest of your agent OS never touches raw subjects.

Recommended bridge interface:

- `startNetwork()`
- `sendMessage(to, threadId, payload)`
- `requestMessage(to, threadId, payload, timeoutMs?)`
- `listOnlineAgents()`
- `getThreadState(threadId)`
- `loadThreadWindow(threadId, cursor?)`
- `handleSystemEvent(msg)`

Keep this bridge thin and deterministic.

## Failure semantics

Treat these as network/runtime errors:

- `delivery_ack_timeout`
- `delivery_rejected`
- `not_registered`
- `not_connected`
- registry RPC timeout/no responders

Do not hide them. Surface in logs with:

- `thread_id`
- `trace_id`
- `message_id`
- target (`account` or `username`)

## Build/use locally now

Inside this repo:

```bash
cd ts-sdk/agentnet-sdk
npm install
npm run build
```

From your other TS repo (local path install):

```bash
npm install /Users/klyexy/Documents/realm/ts-sdk/agentnet-sdk
```

## LLM prompt seed (for coding assistant in your TS repo)

Use this exact instruction seed:

1. "Use AgentNet as network-only layer over NATS. Do not add HTTP transport."
2. "Implement a `networkBridge.ts` wrapper around `agentnet-sdk`."
3. "All messages must carry `thread_id`, `trace_id`, and set `parent_message_id` when replying."
4. "Handle `compaction_required` system events by writing `checkpoint` messages."
5. "Keep orchestration/tool logic out of network bridge."
6. "Add integration tests for send/request, thread status, and compaction event flow."

---

If behavior differs from this document, treat the protocol subjects/payloads in this repo as source of truth.
