import { NetworkBridge } from "./networkBridge.js";
import { secrets, getAgentModelConfig, type AgentModelConfig } from "./config.js";
import { chatCompletion, type ChatMessage } from "./llm.js";
import { handleCompaction } from "./compaction.js";
import { isProtocolMessage, createChat } from "./protocol.js";
import { ToolRegistry, type ToolSpec } from "./tools/registry.js";
import type { AgentMessage, SendOptions } from "agentnet-sdk";

interface QueuedTask {
    message: AgentMessage;
    ctx: { reply: (payload: unknown, options?: SendOptions) => Promise<string> };
}

export interface AgentOptions {
    id: string;
    name: string;
    systemPrompt: string;
    capabilities?: string[];
    tools?: ToolSpec[];
}

type TurnPhase = "RECEIVED" | "ROUTING" | "WAITING" | "SYNTHESIZING" | "REPLIED";

interface TurnState {
    turnId: string;
    threadId: string;
    from: string;
    phase: TurnPhase;
    pendingDelegations: number;
    replied: boolean;
}

interface CanonicalPayloadState {
    sourceAgent: string;
    payload: string;
    contract: "none" | "nba_agent2_verbatim" | "autonba_verbatim";
}

const CONTEXT_SOFT_CAP_TOKENS = Number(process.env.CONTEXT_SOFT_CAP_TOKENS ?? 150_000);
const CONTEXT_HARD_CAP_TOKENS = Number(process.env.CONTEXT_HARD_CAP_TOKENS ?? 180_000);
const THREAD_TAIL_MESSAGES = Number(process.env.THREAD_TAIL_MESSAGES ?? 24);
const LOOP_TAIL_MESSAGES = Number(process.env.LOOP_TAIL_MESSAGES ?? 18);
const TOOL_RESULT_SUMMARY_CHARS = Number(process.env.TOOL_RESULT_SUMMARY_CHARS ?? 3_500);
const TOOL_RESULT_VERBATIM_CHARS = Number(process.env.TOOL_RESULT_VERBATIM_CHARS ?? 30_000);
const MAX_MESSAGE_CHARS_AFTER_TRIM = Number(process.env.MAX_MESSAGE_CHARS_AFTER_TRIM ?? 2_200);

/**
 * The blueprint for all agents.
 *
 * Each instance gets its own NATS connection (via NetworkBridge),
 * its own model config (from agents.yaml), and uses the LLM to
 * process incoming messages.
 */
export class Agent {
    public readonly id: string;
    public readonly name: string;
    private readonly systemPrompt: string;
    private readonly modelConfig: AgentModelConfig;
    private readonly toolRegistry = new ToolRegistry();
    private readonly turnStates = new Map<string, TurnState>();

    // Lane-based task queue: messages are processed one at a time
    private readonly queue: QueuedTask[] = [];
    private processing = false;

    // The connection to AgentNet
    private readonly network: NetworkBridge;

    constructor(opts: AgentOptions) {
        this.id = opts.id;
        this.name = opts.name;
        this.systemPrompt = opts.systemPrompt;
        this.modelConfig = getAgentModelConfig(opts.id);

        if (opts.tools) {
            for (const t of opts.tools) this.toolRegistry.register(t);
        }

        // Create the NATS bridge for this specific agent
        this.network = new NetworkBridge({
            natsUrl: secrets.natsUrl,
            agentId: this.id,
            name: this.name,
            capabilities: opts.capabilities || [],
        });
    }

    /** Start the agent: connect to NATS and start listening for messages. */
    public async start(): Promise<void> {
        console.log(`[${this.name}] Starting up... (model: ${this.modelConfig.model})`);

        // Auto-handle thread compaction events
        this.network.onCompaction(async (event) => {
            await handleCompaction(this.network, event, this.id);
        });

        await this.network.startNetwork(async (message, ctx) => {
            this.enqueue(message, ctx);
        });

        console.log(`[${this.name}] Online and listening.`);
    }

    /** Graceful shutdown. */
    public async stop(): Promise<void> {
        console.log(`[${this.name}] Shutting down...`);
        await this.network.stopNetwork();
    }

    /** Push a message onto this agent's lane queue. */
    private enqueue(
        message: AgentMessage,
        ctx: { reply: (payload: unknown, options?: SendOptions) => Promise<string> }
    ): void {
        this.queue.push({ message, ctx });
        console.log(`[${this.name}] Queued task (${this.queue.length} in lane)`);
        // If we're not already processing, start draining
        if (!this.processing) {
            void this.drainQueue();
        }
    }

    /** Process queued tasks one at a time (FIFO). */
    private async drainQueue(): Promise<void> {
        this.processing = true;
        while (this.queue.length > 0) {
            const task = this.queue.shift()!;
            await this.handleIncomingMessage(task.message, task.ctx);
        }
        this.processing = false;
    }

    private beginTurnState(message: AgentMessage): TurnState {
        const threadId = message.thread_id ?? "no_thread";
        const turnId = `${threadId}:${message.message_id}`;
        const state: TurnState = {
            turnId,
            threadId,
            from: message.from_agent,
            phase: "RECEIVED",
            pendingDelegations: 0,
            replied: false,
        };
        this.turnStates.set(turnId, state);
        console.log(`[${this.name}] Turn ${turnId} phase=RECEIVED`);
        return state;
    }

    private transitionTurnState(state: TurnState, next: TurnPhase, reason: string): void {
        if (state.phase === next) return;
        state.phase = next;
        console.log(`[${this.name}] Turn ${state.turnId} phase=${next} (${reason})`);
    }

    private endTurnState(turnId: string): void {
        this.turnStates.delete(turnId);
    }

    /** The main "brain" loop for when a message arrives. */
    private async handleIncomingMessage(
        message: AgentMessage,
        ctx: { reply: (payload: unknown, options?: SendOptions) => Promise<string> }
    ): Promise<void> {
        console.log(`[${this.name}] Received message from ${message.from_agent}`);
        let turnState: TurnState | null = null;

        try {
            const incomingProtocol = isProtocolMessage(message.payload) ? message.payload : null;
            const hasReplyChannel = Boolean(message.reply_to);
            const isExternalUserMessage = ![secrets.orchestratorId, "agent1", "agent2", "agent3"].includes(message.from_agent);
            const isOrchestratorUserTurn = this.id === secrets.orchestratorId && isExternalUserMessage && hasReplyChannel;
            turnState = isOrchestratorUserTurn
                ? this.beginTurnState(message)
                : null;

            // Orchestrator receives async DONE/BLOCKED worker events with no reply subject.
            // These are consumed by assignTasks polling and should not trigger a new user reply loop.
            if (
                this.id === secrets.orchestratorId
                && !hasReplyChannel
                && incomingProtocol
                && (incomingProtocol.type === "done" || incomingProtocol.type === "blocked")
            ) {
                console.log(`[${this.name}] Async ${incomingProtocol.type.toUpperCase()} from ${message.from_agent}; no reply channel, skipping.`);
                return;
            }

            let repliedToCaller = false;
            const replySafely = async (payload: unknown, options?: SendOptions): Promise<string> => {
                repliedToCaller = true;
                return ctx.reply(payload, options);
            };

            const incomingProtocolType = incomingProtocol?.type ?? null;
            const isAssignmentOrDebateThread = Boolean(
                message.thread_id
                && (
                    incomingProtocolType === "assign"
                    || message.thread_id.startsWith("debate_")
                )
            );
            if (turnState) {
                this.transitionTurnState(turnState, "ROUTING", "message accepted");
            }

            // Include fromAgent if present so the LLM knows who is talking to them
            let textBlock = typeof message.payload === "string"
                ? message.payload
                : isProtocolMessage(message.payload)
                    ? `[PROTOCOL: ${message.payload.type.toUpperCase()}]\n${message.payload.text}`
                    : JSON.stringify(message.payload);

            if (typeof message.payload === "object" && message.payload !== null && "fromAgent" in message.payload) {
                const fromStr = `[Message from: ${(message.payload as any).fromAgent}]\n`;
                textBlock = fromStr + textBlock;
            }

            const currentTime = new Date().toISOString();
            const timePrompt = `[SYSTEM TIME ALIGNMENT: The current exact time is ${currentTime}]`;

            const historyPrompt = await this.buildHistoryPrompt(message.thread_id);

            let messages: ChatMessage[] = [
                { role: "system", content: `${this.systemPrompt}\n\n${timePrompt}${historyPrompt}` },
                { role: "user", content: textBlock },
            ];

            // Let the agent loop until it returns actual text
            let finalResponse: string | null = null;
            const toolsApi = this.toolRegistry.hasTools() ? this.toolRegistry.getOpenAITools() : undefined;
            const MAX_TOOL_ROUNDS = 20;
            const HARD_STOP_ROUNDS = 30;
            let round = 0;
            let delegatedResultReceived = false;
            let blockedPostDelegationAttempts = 0;
            let lastDelegatedResultText: string | null = null;
            let runtimeCheckpointWritten = false;
            let canonicalPayload: CanonicalPayloadState | null = null;

            while (finalResponse === null) {
                round++;
                if (round > HARD_STOP_ROUNDS) {
                    throw new Error("Strict assignment mode: agent did not call markTaskDone/reportError within the hard tool-round limit.");
                }
                if (round > MAX_TOOL_ROUNDS) {
                    messages.push({
                        role: "system",
                        content: "SYSTEM: You have reached the maximum allowed tool execution rounds. You MUST immediately call the `markTaskDone` tool or `reportError` tool with the information you have gathered so far. You are not allowed to use any other tools.",
                    });
                }
                const budgetReduction = await this.reduceMessagesForBudget(
                    messages,
                    message.thread_id,
                    runtimeCheckpointWritten
                );
                messages = budgetReduction.messages;
                runtimeCheckpointWritten = runtimeCheckpointWritten || budgetReduction.checkpointWritten;

                console.log(`[${this.name}] Thinking... (round ${round}/${MAX_TOOL_ROUNDS})`);
                const responseText = await chatCompletion(messages, this.modelConfig, {
                    tools: toolsApi
                });

                // 1. Did the LLM return a Tool Call request object?
                if (responseText.includes('{"_isToolCall":true')) {
                    const tc = JSON.parse(responseText);
                    if (turnState?.replied) {
                        console.log(`[${this.name}] Turn ${turnState.turnId} already replied; skipping further tool calls.`);
                        return;
                    }
                    if (
                        turnState
                        && turnState.pendingDelegations > 0
                        && (tc.name === "answerDirectly" || tc.name === "endConversation")
                    ) {
                        messages.push({
                            role: "system",
                            content: "SYSTEM: You still have delegated work in progress for this turn. Wait for results before answering or ending the conversation.",
                        });
                        continue;
                    }
                    if (
                        this.id === secrets.orchestratorId
                        && isExternalUserMessage
                        && delegatedResultReceived
                        && (tc.name === "searchWeb" || tc.name === "deepSearch")
                    ) {
                        console.log(`[${this.name}] Blocked ${tc.name} after delegated result; forcing finalization to user.`);
                        blockedPostDelegationAttempts += 1;
                        if (blockedPostDelegationAttempts >= 2 && isOrchestratorUserTurn) {
                            const fallbackAnswer = canonicalPayload?.payload
                                ?? lastDelegatedResultText
                                ?? "I received delegated results but could not complete synthesis. Returning the worker output as-is.";
                            await replySafely(createChat(fallbackAnswer));
                            if (turnState) {
                                turnState.replied = true;
                                this.transitionTurnState(turnState, "REPLIED", "fallback reply after repeated blocked post-delegation tool calls");
                                this.endTurnState(turnState.turnId);
                            }
                            return;
                        }
                        messages.push({
                            role: "system",
                            content: "SYSTEM: You already received delegated results from worker agents for this user turn. Do NOT run searchWeb/deepSearch now. You MUST finalize to the user immediately via answerDirectly.",
                        });
                        continue;
                    }
                    if (
                        this.id === secrets.orchestratorId
                        && isExternalUserMessage
                        && delegatedResultReceived
                        && tc.name === "chatWithAgent"
                    ) {
                        console.log(`[${this.name}] Blocked follow-up chatWithAgent after delegated result; forcing user reply.`);
                        blockedPostDelegationAttempts += 1;
                        if (blockedPostDelegationAttempts >= 2 && isOrchestratorUserTurn) {
                            const fallbackAnswer = canonicalPayload?.payload
                                ?? lastDelegatedResultText
                                ?? "I received delegated results but could not complete synthesis. Returning the worker output as-is.";
                            await replySafely(createChat(fallbackAnswer));
                            if (turnState) {
                                turnState.replied = true;
                                this.transitionTurnState(turnState, "REPLIED", "fallback reply after repeated blocked post-delegation tool calls");
                                this.endTurnState(turnState.turnId);
                            }
                            return;
                        }
                        messages.push({
                            role: "system",
                            content: "SYSTEM: You already received a successful delegated result for this user turn. Do NOT ask workers follow-up questions now. You MUST immediately call answerDirectly with: (1) the data you have, and (2) a clear list of missing fields if any.",
                        });
                        continue;
                    }

                    console.log(`[${this.name}] Executing Tool: ${tc.name}`);
                    const isDelegationTool = this.id === secrets.orchestratorId
                        && (tc.name === "assignTasks" || tc.name === "chatWithAgent" || tc.name === "facilitateDebate");
                    if (turnState && isDelegationTool) {
                        turnState.pendingDelegations += 1;
                        this.transitionTurnState(turnState, "WAITING", `delegating via ${tc.name}`);
                    }
                    if (turnState && tc.name === "answerDirectly") {
                        this.transitionTurnState(turnState, "SYNTHESIZING", "preparing final user reply");
                        if (canonicalPayload?.contract === "nba_agent2_verbatim" || canonicalPayload?.contract === "autonba_verbatim") {
                            try {
                                const parsedArgs = JSON.parse(tc.arguments ?? "{}");
                                parsedArgs.answer = canonicalPayload.payload;
                                tc.arguments = JSON.stringify(parsedArgs);
                                console.log(`[${this.name}] Enforced verbatim output contract (${canonicalPayload.contract}) from ${canonicalPayload.sourceAgent}.`);
                            } catch {
                                // Let normal execution continue if tool args are malformed.
                            }
                        }
                    }

                    // Execute the local TS function
                    const toolResult = await this.toolRegistry.executeTool(tc.name, tc.arguments, {
                        agentId: this.id,
                        bridge: this.network,
                        threadId: message.thread_id,
                        hasReplyChannel,
                        reply: replySafely,
                    });

                    console.log(`[${this.name}] Tool ${tc.name} returned: ${toolResult}`);
                    if (
                        this.id === secrets.orchestratorId
                        && (tc.name === "assignTasks" || tc.name === "chatWithAgent")
                    ) {
                        const extracted = extractCanonicalPayloadFromDelegatedResult(toolResult);
                        if (extracted?.payload) {
                            lastDelegatedResultText = extracted.payload;
                        } else if (!toolResult.startsWith("Error:")) {
                            lastDelegatedResultText = toolResult;
                        }
                        if (extracted && looksLikeNbaCanonicalPayload(extracted.payload)) {
                            canonicalPayload = {
                                sourceAgent: extracted.sourceAgent,
                                payload: extracted.payload,
                                contract: extracted.sourceAgent === "agent2" ? "nba_agent2_verbatim" : "none",
                            };
                        }
                    }
                    if (
                        this.id === secrets.orchestratorId
                        && tc.name === "runAutonomousNbaPick"
                        && toolResult.startsWith("[AUTONBA_FINAL]")
                    ) {
                        canonicalPayload = {
                            sourceAgent: "orchestrator_autonomous",
                            payload: stripProtocolPrefix(toolResult),
                            contract: "autonba_verbatim",
                        };
                    }
                    if (turnState && isDelegationTool) {
                        turnState.pendingDelegations = Math.max(0, turnState.pendingDelegations - 1);
                        this.transitionTurnState(turnState, "SYNTHESIZING", `received ${tc.name} result`);
                    }
                    if ((tc.name === "assignTasks" || tc.name === "chatWithAgent") && !toolResult.startsWith("Error:")) {
                        delegatedResultReceived = true;
                    }

                    if (tc.name === "markTaskDone" && toolResult.includes("Successfully sent [PROTOCOL: DONE]")) {
                        // The agent successfully completed the task via tool selection.
                        // Break out of the reasoning loop immediately so it doesn't try to parse
                        // the success message and output more conversational text.
                        return;
                    }

                    if (tc.name === "endConversation" && toolResult.includes("Successfully ended the conversation")) {
                        if (isExternalUserMessage && !repliedToCaller) {
                            console.log(`[${this.name}] Prevented silent endConversation on user thread without a reply.`);
                            messages.push({
                                role: "system",
                                content: "SYSTEM: You cannot end this user conversation yet because no reply has been sent. You MUST either answer directly or call answerDirectly first.",
                            });
                            continue;
                        }
                        console.log(`[${this.name}] explicitly ended the conversation.`);
                        if (turnState) {
                            this.transitionTurnState(turnState, "REPLIED", "conversation ended after reply");
                            turnState.replied = true;
                            this.endTurnState(turnState.turnId);
                        }
                        return;
                    }
                    if (turnState && tc.name === "answerDirectly") {
                        const sent = toolResult.startsWith("Successfully sent the answer to the user:");
                        if (sent) {
                            turnState.replied = true;
                            this.transitionTurnState(turnState, "REPLIED", "final reply sent via answerDirectly");
                            this.endTurnState(turnState.turnId);
                            return;
                        }
                    }

                    // Append the tool call and the result to the conversation context
                    messages.push({ role: "assistant", content: `(I called tool ${tc.name} with ${tc.arguments})` });
                    const preserveDelegationResult = this.id === secrets.orchestratorId
                        && (tc.name === "assignTasks" || tc.name === "chatWithAgent" || tc.name === "facilitateDebate");
                    const compactToolResult = preserveDelegationResult
                        ? trimToChars(toolResult, TOOL_RESULT_VERBATIM_CHARS)
                        : summarizeToolOutput(tc.name, toolResult, TOOL_RESULT_SUMMARY_CHARS);
                    const toolResultPrefix = preserveDelegationResult ? "Tool Result (verbatim):" : "Tool Result:";
                    messages.push({
                        role: "user",
                        content: `${toolResultPrefix} ${compactToolResult}\nEvaluate this result. If you need more information, call another tool. If you have finished your task, call the appropriate tool to complete it (e.g., markTaskDone). If you are chatting, you may respond directly.`
                    });
                } else {
                    // 2. The LLM returned raw text
                    if (isOrchestratorUserTurn && looksLikeInternalTrace(responseText)) {
                        messages.push({
                            role: "system",
                            content: "SYSTEM: Do not output internal traces or tool-call notes to the user. Provide a clean user-facing answer only.",
                        });
                        continue;
                    }
                    if (isOrchestratorUserTurn) {
                        if (canonicalPayload?.contract === "nba_agent2_verbatim" || canonicalPayload?.contract === "autonba_verbatim") {
                            messages.push({
                                role: "system",
                                content: "SYSTEM: Output contract active. You MUST call answerDirectly and send the canonical payload verbatim with no summarization or reformatting.",
                            });
                            continue;
                        }
                        messages.push({
                            role: "system",
                            content: "SYSTEM: For user-thread responses, do not return raw assistant text. You MUST call answerDirectly to send the final answer.",
                        });
                        continue;
                    }
                    if (isAssignmentOrDebateThread) {
                        messages.push({
                            role: "assistant",
                            content: responseText,
                        });
                        messages.push({
                            role: "user",
                            content: "STRICT MODE: On assignment/debate threads, raw text is not a valid completion. You MUST call markTaskDone with resultSummary, or reportError with reason/errorLog. Do not call endConversation.",
                        });
                        continue;
                    }
                    finalResponse = responseText;
                }
            }

            console.log(`[${this.name}] Processing final response.`);

            // Otherwise, route as normal chat
            // Always reply using the standard protocol envelope
            // Use safe reply — fire-and-forget messages have no reply subject
            try {
                await replySafely(createChat(finalResponse || "(Empty response)"));
                if (turnState) {
                    turnState.replied = true;
                    this.transitionTurnState(turnState, "REPLIED", "final raw-text reply sent");
                    this.endTurnState(turnState.turnId);
                }
            } catch (replyErr: any) {
                if (replyErr?.code === "missing_reply_to") {
                    // Fire-and-forget message — no one to reply to, just log and move on
                    console.log(`[${this.name}] No reply subject (fire-and-forget). Response processed but not routed back.`);
                } else {
                    throw replyErr;
                }
            }
        } catch (error) {
            console.error(`[${this.name}] Error handling message:`, error);
            try {
                await ctx.reply(createChat("I encountered an internal error while processing your request."));
            } catch {
                // Fire-and-forget error reply — best effort
                console.log(`[${this.name}] Could not send error reply (no reply subject).`);
            }
            if (turnState) {
                this.endTurnState(turnState.turnId);
            }
        }
    }

    private async buildHistoryPrompt(threadId?: string): Promise<string> {
        if (!threadId) return "";

        try {
            const history = await this.network.loadThreadWindow(threadId);
            if (!history || !Array.isArray(history.messages) || history.messages.length === 0) {
                return "";
            }

            const sorted = [...history.messages].sort((a: any, b: any) => {
                const ta = Number(a?.timestamp ?? 0);
                const tb = Number(b?.timestamp ?? 0);
                return ta - tb;
            });

            // Exclude current incoming message if it is already persisted in thread history.
            const priorMessages = sorted.length > 1 ? sorted.slice(0, -1) : [];
            if (priorMessages.length === 0) return "";

            let latestCheckpointSummary = "";
            let latestCheckpointIndex = -1;

            for (let i = priorMessages.length - 1; i >= 0; i--) {
                const checkpoint = parseCheckpointPayload(priorMessages[i]?.payload);
                if (checkpoint?.summary) {
                    latestCheckpointSummary = checkpoint.summary;
                    latestCheckpointIndex = i;
                    break;
                }
            }

            const afterCheckpoint = latestCheckpointIndex >= 0
                ? priorMessages.slice(latestCheckpointIndex + 1)
                : priorMessages;

            const tailMessages = afterCheckpoint
                .filter((m: any) => !parseCheckpointPayload(m?.payload))
                .slice(-Math.max(1, THREAD_TAIL_MESSAGES));

            const renderedTail = tailMessages
                .map((m: any) => {
                    const sender = String(m?.from_username ?? m?.from_agent ?? m?.sender_id ?? "unknown");
                    const text = formatPayloadForHistory(m?.payload);
                    return `[${sender}]: ${trimToChars(text, 700)}`;
                })
                .join("\n");

            const sections: string[] = [];
            if (latestCheckpointSummary) {
                sections.push(`Latest checkpoint summary:\n${trimToChars(latestCheckpointSummary, 3000)}`);
            }
            if (renderedTail) {
                sections.push(`Recent tail messages (${Math.max(1, THREAD_TAIL_MESSAGES)}):\n${renderedTail}`);
            }
            if (sections.length === 0) return "";

            return `\n\n--- THREAD CONTEXT (Checkpoint + Tail) ---\n${sections.join("\n\n")}\n------------------------------------------`;
        } catch {
            console.log(`[${this.name}] Warning: Could not load thread history for ${threadId}`);
            return "";
        }
    }

    private async reduceMessagesForBudget(
        input: ChatMessage[],
        threadId: string | undefined,
        checkpointAlreadyWritten: boolean,
    ): Promise<{ messages: ChatMessage[]; checkpointWritten: boolean }> {
        let messages = input.map((m) => ({
            ...m,
            content: maybeCondenseToolResultEnvelope(m.content),
        }));
        const originalEstimate = estimateMessageTokens(messages);
        if (originalEstimate <= CONTEXT_SOFT_CAP_TOKENS) {
            return { messages, checkpointWritten: false };
        }

        const tailStart = Math.max(1, messages.length - Math.max(2, LOOP_TAIL_MESSAGES));
        const dropped = messages.slice(1, tailStart);
        const carryover = dropped.length > 0
            ? summarizeDroppedMessages(dropped)
            : "Context trimmed for token budget.";

        messages = [
            messages[0],
            { role: "system", content: `CONTEXT CHECKPOINT SUMMARY:\n${carryover}` },
            ...messages.slice(tailStart),
        ];

        if (estimateMessageTokens(messages) > CONTEXT_SOFT_CAP_TOKENS) {
            messages = messages.map((m, idx) =>
                idx === 0 ? m : { ...m, content: trimToChars(m.content, MAX_MESSAGE_CHARS_AFTER_TRIM) }
            );
        }

        let checkpointWritten = false;
        if (
            threadId
            && !checkpointAlreadyWritten
            && estimateMessageTokens(messages) > CONTEXT_SOFT_CAP_TOKENS
        ) {
            checkpointWritten = await this.writeRuntimeCheckpoint(threadId, carryover);
            if (checkpointWritten) {
                const shorterTailStart = Math.max(1, messages.length - 10);
                messages = [messages[0], { role: "system", content: `CONTEXT CHECKPOINT SUMMARY:\n${carryover}` }, ...messages.slice(shorterTailStart)];
            }
        }

        while (estimateMessageTokens(messages) > CONTEXT_HARD_CAP_TOKENS && messages.length > 3) {
            messages.splice(2, 1);
        }

        return { messages, checkpointWritten };
    }

    private async writeRuntimeCheckpoint(threadId: string, summary: string): Promise<boolean> {
        try {
            const state = await this.network.getThreadState(threadId);
            const accountId = this.network.raw.getAccountId();
            if (!accountId) return false;

            const messageCount = asInt(state["message_count"], 0);
            const latestCheckpointEnd = asInt(state["latest_checkpoint_end"], 0);
            const keepTail = Math.max(Math.max(1, THREAD_TAIL_MESSAGES), asInt(state["keep_tail_messages"], THREAD_TAIL_MESSAGES));
            const coversStart = Math.max(1, latestCheckpointEnd + 1);
            const coversEnd = Math.max(coversStart, messageCount - keepTail);

            await this.network.sendMessage(
                `account:${accountId}`,
                threadId,
                {
                    type: "checkpoint",
                    summary_version: "v1",
                    covers_start: coversStart,
                    covers_end: coversEnd,
                    summary: trimToChars(summary, 6000),
                },
                { kind: "system", requireDeliveryAck: false },
            );
            console.log(`[${this.name}] Runtime checkpoint written for ${threadId} (covers ${coversStart}..${coversEnd}).`);
            return true;
        } catch (err: any) {
            console.log(`[${this.name}] Runtime checkpoint skipped: ${err?.message ?? String(err)}`);
            return false;
        }
    }

}

function asInt(value: unknown, fallback = 0): number {
    const num = Number(value);
    return Number.isFinite(num) ? Math.trunc(num) : fallback;
}

function trimToChars(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    return `${text.slice(0, Math.max(0, maxChars - 80))}\n...[trimmed ${text.length - maxChars} chars]`;
}

function estimateMessageTokens(messages: ChatMessage[]): number {
    const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
    return Math.ceil(totalChars / 4);
}

function parsePayloadObject(payload: unknown): Record<string, unknown> | null {
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        return payload as Record<string, unknown>;
    }
    if (typeof payload === "string") {
        try {
            const parsed = JSON.parse(payload);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                return parsed as Record<string, unknown>;
            }
        } catch {
            return null;
        }
    }
    return null;
}

function parseCheckpointPayload(payload: unknown): { summary: string } | null {
    const obj = parsePayloadObject(payload);
    if (!obj) return null;
    if (String(obj.type ?? "") !== "checkpoint") return null;
    if (typeof obj.summary !== "string" || !obj.summary.trim()) return null;
    return { summary: obj.summary.trim() };
}

function formatPayloadForHistory(payload: unknown): string {
    if (typeof payload === "string") {
        return payload;
    }
    const obj = parsePayloadObject(payload);
    if (!obj) {
        return String(payload);
    }
    const type = typeof obj.type === "string" ? obj.type : "";
    const text = typeof obj.text === "string" ? obj.text : "";
    if (type === "checkpoint") {
        const summary = typeof obj.summary === "string" ? obj.summary : "";
        return `[CHECKPOINT] ${trimToChars(summary, 400)}`;
    }
    if (type && text) {
        return `[${type.toUpperCase()}] ${text}`;
    }
    return JSON.stringify(obj);
}

function summarizeToolOutput(toolName: string, text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;

    const lines = text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    const keyLines = lines
        .filter((line) => /^(\d+[\).\]]|[-*•]|[A-Za-z][A-Za-z0-9 _-]{0,30}:)/.test(line))
        .slice(0, 20);

    const head = trimToChars(text, Math.floor(maxChars * 0.45));
    const tail = text.slice(-Math.floor(maxChars * 0.2));

    return [
        `[Tool output condensed for context]`,
        `Tool: ${toolName}`,
        `Original length: ${text.length} chars`,
        keyLines.length ? `Key lines:\n- ${keyLines.join("\n- ")}` : "Key lines: (none extracted)",
        `Head snippet:\n${head}`,
        `Tail snippet:\n${tail}`,
    ].join("\n\n");
}

function maybeCondenseToolResultEnvelope(content: string): string {
    const prefix = "Tool Result:";
    if (!content.startsWith(prefix)) return content;

    const marker = "\nEvaluate this result.";
    const markerIndex = content.indexOf(marker);
    const resultBody = markerIndex >= 0
        ? content.slice(prefix.length, markerIndex).trim()
        : content.slice(prefix.length).trim();
    const suffix = markerIndex >= 0 ? content.slice(markerIndex) : "";
    const condensed = summarizeToolOutput("unknown", resultBody, TOOL_RESULT_SUMMARY_CHARS);
    return `Tool Result: ${condensed}${suffix}`;
}

function summarizeDroppedMessages(messages: ChatMessage[]): string {
    const preview = messages
        .slice(-8)
        .map((m) => `- ${m.role}: ${trimToChars(m.content.replace(/\s+/g, " ").trim(), 260)}`)
        .join("\n");
    const count = messages.length;
    const approxTokens = estimateMessageTokens(messages);
    return `Dropped ${count} older in-loop messages (~${approxTokens} tokens est). Latest dropped highlights:\n${preview}`;
}

function looksLikeInternalTrace(text: string): boolean {
    const t = text.toLowerCase();
    return t.includes("(i called tool")
        || t.includes("tool result:")
        || t.includes("delivered agent")
        || t.includes("sent debate turn")
        || t.includes("waiting for terminal reply");
}

function extractCanonicalPayloadFromDelegatedResult(toolResult: string): { sourceAgent: string; payload: string } | null {
    // chatWithAgent format:
    // Reply from agent2 on thread ...:
    // [DONE] ...
    const chatMatch = toolResult.match(/^Reply from ([a-zA-Z0-9_:-]+) on thread[\s\S]*?:\n([\s\S]+)$/m);
    if (chatMatch) {
        return {
            sourceAgent: chatMatch[1].trim(),
            payload: stripProtocolPrefix(chatMatch[2].trim()),
        };
    }

    // assignTasks format:
    // [Result from agent2]:
    // ...
    const assignMatch = toolResult.match(/\[Result from ([a-zA-Z0-9_:-]+)\]:\n([\s\S]+)/m);
    if (assignMatch) {
        return {
            sourceAgent: assignMatch[1].trim(),
            payload: stripProtocolPrefix(assignMatch[2].trim()),
        };
    }

    return null;
}

function stripProtocolPrefix(text: string): string {
    if (text.startsWith("[DONE]")) return text.replace(/^\[DONE\]\s*/, "");
    if (text.startsWith("[CHAT]")) return text.replace(/^\[CHAT\]\s*/, "");
    return text;
}

function looksLikeNbaCanonicalPayload(text: string): boolean {
    const t = text.toLowerCase();
    const nbaSignals = [
        "pre-game analysis dossier",
        "season stats",
        "injury report",
        "game details",
    ];
    return nbaSignals.filter((s) => t.includes(s)).length >= 2;
}
