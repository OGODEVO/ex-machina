import { NetworkBridge } from "./networkBridge.js";
import { secrets, getAgentModelConfig, type AgentModelConfig } from "./config.js";
import { chatCompletion, type ChatMessage } from "./llm.js";
import { handleCompaction } from "./compaction.js";
import { isProtocolMessage, createChat, type ProtocolMessage } from "./protocol.js";
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

    /** The main "brain" loop for when a message arrives. */
    private async handleIncomingMessage(
        message: AgentMessage,
        ctx: { reply: (payload: unknown, options?: SendOptions) => Promise<string> }
    ): Promise<void> {
        console.log(`[${this.name}] Received message from ${message.from_agent}`);

        try {
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

            // Load thread history for context (last 10 messages)
            let historyPrompt = "";
            if (message.thread_id) {
                try {
                    const history = await this.network.loadThreadWindow(message.thread_id);
                    if (history && Array.isArray(history.messages)) {
                        // Take up to the last 10 messages, but EXCLUDE the current incoming message
                        // since NATS might have already appended it to the log.
                        // Sort by timestamp, take last 11, slice off the newest one.
                        const pastMsgs = history.messages
                            .sort((a: any, b: any) => a.timestamp - b.timestamp)
                            .slice(-11, -1) // Grab the 10 messages *before* this one
                            .map((m: any) => {
                                const sender = m.from_username || m.from_agent || m.sender_id || "unknown";
                                const text = typeof m.payload === "string" ? m.payload : JSON.stringify(m.payload);
                                return `[${sender}]: ${text}`;
                            }).join("\n");

                        if (pastMsgs) {
                            historyPrompt = `\n\n--- PREVIOUS THREAD MESSAGES (For Context) ---\n${pastMsgs}\n------------------------------------------`;
                        }
                    }
                } catch (e) {
                    console.log(`[${this.name}] Warning: Could not load thread history for ${message.thread_id}`);
                }
            }

            const messages: ChatMessage[] = [
                { role: "system", content: `${this.systemPrompt}\n\n${timePrompt}${historyPrompt}` },
                { role: "user", content: textBlock },
            ];

            // Let the agent loop until it returns actual text
            let finalResponse = "";
            const toolsApi = this.toolRegistry.hasTools() ? this.toolRegistry.getOpenAITools() : undefined;
            const MAX_TOOL_ROUNDS = 10;
            let round = 0;

            while (!finalResponse) {
                round++;
                if (round > MAX_TOOL_ROUNDS) {
                    finalResponse = "I hit my tool execution limit. Here is what I have so far.";
                    break;
                }
                console.log(`[${this.name}] Thinking... (round ${round}/${MAX_TOOL_ROUNDS})`);
                const responseText = await chatCompletion(messages, this.modelConfig, {
                    tools: toolsApi
                });

                // 1. Did the LLM return a Tool Call request object?
                if (responseText.includes('{"_isToolCall":true')) {
                    const tc = JSON.parse(responseText);
                    console.log(`[${this.name}] Executing Tool: ${tc.name}`);

                    // Execute the local TS function
                    const toolResult = await this.toolRegistry.executeTool(tc.name, tc.arguments, {
                        agentId: this.id,
                        bridge: this.network,
                        threadId: message.thread_id,
                    });

                    console.log(`[${this.name}] Tool ${tc.name} returned: ${toolResult}`);

                    // Append the tool call and the result to the conversation context
                    messages.push({ role: "assistant", content: `(I called tool ${tc.name} with ${tc.arguments})` });
                    messages.push({ role: "user", content: `Tool Result: ${toolResult}\nBased on this result, you must output a direct text response to continue.` });
                } else {
                    // 2. The LLM returned raw text
                    finalResponse = responseText;
                }
            }

            console.log(`[${this.name}] Replying.`);
            // Always reply using the standard protocol envelope
            // Use safe reply — fire-and-forget messages have no reply subject
            try {
                await ctx.reply(createChat(finalResponse));
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
        }
    }

    /** Safely pull text from an unknown JSON payload. */
    private extractTextFromPayload(payload: unknown): string | null {
        if (typeof payload === "string") return payload;
        if (typeof payload === "object" && payload !== null && "text" in payload) {
            return String((payload as Record<string, unknown>).text);
        }
        return null;
    }
}
