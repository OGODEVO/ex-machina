/**
 * compaction.ts — thread budget handler.
 *
 * When the network signals `compaction_required`, this module:
 * 1. Fetches thread messages
 * 2. Summarizes old ranges with the LLM
 * 3. Writes a checkpoint message back to the thread
 */

import type { CompactionRequiredEvent } from "agentnet-sdk";
import type { NetworkBridge } from "./networkBridge.js";
import { chatCompletion } from "./llm.js";
import { getAgentModelConfig } from "./config.js";

const COMPACTION_SYSTEM_PROMPT = `You are a thread compaction assistant.
You will receive a block of conversation messages from an agent thread.
Your job is to produce a concise but complete summary that preserves:
- All key decisions made
- All facts/data referenced
- Task assignments and their outcomes
- Any unresolved questions or blockers

Output ONLY the summary text, no preamble.`;

/**
 * Handle a compaction_required event:
 * fetch old messages, summarize, and write a checkpoint.
 */
export async function handleCompaction(
    bridge: NetworkBridge,
    event: CompactionRequiredEvent,
    agentId: string,
): Promise<void> {
    const threadId = event.thread_id;
    const coversStart = Math.max(1, event.latest_checkpoint_end + 1);
    const coversEnd = Math.max(coversStart, event.message_count - event.keep_tail_messages);

    if (coversEnd <= coversStart) {
        console.log(`[compaction] thread=${threadId} nothing to compact`);
        return;
    }

    console.log(`[compaction] thread=${threadId} compacting msgs ${coversStart}..${coversEnd}`);

    // 1. Fetch messages in the compaction window
    const threadData = await bridge.loadThreadWindow(threadId);
    const messages = Array.isArray(threadData.messages) ? threadData.messages : [];

    if (messages.length === 0) {
        console.log(`[compaction] thread=${threadId} no messages returned`);
        return;
    }

    // Filter messages to only those in our target range
    // Assuming the network returns messages ordered by sequence or we just format all we got
    // A production implement might need precise slice logic based on msg sequence numbers if available.
    const textBlock = messages
        .map((m: any) => {
            const from = String(m.from_agent ?? "unknown");
            const payload = m.payload;
            const text =
                typeof payload === "string"
                    ? payload
                    : typeof payload === "object" && payload && "text" in payload
                        ? String((payload as any).text)
                        : JSON.stringify(payload);
            return `[${from}]: ${text}`;
        })
        .join("\n");

    // 2. Summarize with LLM (using this agent's model config)
    const agentConfig = getAgentModelConfig(agentId);
    const summary = await chatCompletion([
        { role: "system", content: COMPACTION_SYSTEM_PROMPT },
        { role: "user", content: textBlock },
    ], agentConfig);

    // 3. Write checkpoint back to thread
    await bridge.sendMessage(
        `account:${bridge.raw.getAccountId()!}`,
        threadId,
        {
            type: "checkpoint",
            summary_version: "v1",
            covers_start: coversStart,
            covers_end: coversEnd,
            summary,
        },
        { kind: "system", requireDeliveryAck: false },
    );

    console.log(`[compaction] thread=${threadId} checkpoint written (covers ${coversStart}..${coversEnd})`);
}
