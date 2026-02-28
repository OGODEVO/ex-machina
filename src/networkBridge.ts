/**
 * networkBridge.ts — thin wrapper around AgentNetClient.
 *
 * Rule: the rest of agent OS never touches raw NATS subjects.
 * Everything goes through this bridge.
 */

import {
    AgentNetClient,
    parseCompactionRequired,
    type AgentMessage,
    type AgentNetClientOptions,
    type AgentInfo,
    type SendOptions,
    type RequestOptions,
    type CompactionRequiredEvent,
} from "agentnet-sdk";

export type InboxHandler = (
    message: AgentMessage,
    ctx: { reply: (payload: unknown, options?: SendOptions) => Promise<string> },
) => Promise<void> | void;

export type CompactionHandler = (event: CompactionRequiredEvent) => Promise<void>;

export interface NetworkBridgeOptions {
    natsUrl: string;
    agentId: string;
    name: string;
    username?: string;
    capabilities?: string[];
    metadata?: Record<string, unknown>;
}

export class NetworkBridge {
    private readonly sdk: AgentNetClient;
    private compactionHandler?: CompactionHandler;

    constructor(opts: NetworkBridgeOptions) {
        this.sdk = new AgentNetClient({
            natsUrl: opts.natsUrl,
            agentId: opts.agentId,
            name: opts.name,
            username: opts.username ?? opts.agentId,
            capabilities: opts.capabilities ?? [],
            metadata: opts.metadata ?? {},
            defaultRequestTimeoutMs: 60_000,
        });
    }

    /** Connect, register, heartbeat, subscribe inbox. */
    async startNetwork(inboxHandler: InboxHandler): Promise<void> {
        await this.sdk.start();

        await this.sdk.subscribeInbox(async (msg, ctx) => {
            // System compaction events intercept first.
            const compaction = parseCompactionRequired(msg);
            if (compaction && this.compactionHandler) {
                await this.compactionHandler(compaction);
                return;
            }
            await inboxHandler(msg, ctx);
        });

        console.log(`[network] agent registered — id=${this.sdk.getAccountId()}`);
    }

    /** Graceful shutdown. */
    async stopNetwork(): Promise<void> {
        await this.sdk.close();
    }

    /** Fire-and-forget with explicit threadId. */
    async sendMessage(to: string, threadId: string, payload: unknown, options?: Omit<SendOptions, "threadId">): Promise<string> {
        return this.sdk.send(to, payload, { ...options, threadId });
    }

    /** Request-reply with explicit threadId. */
    async requestMessage(to: string, threadId: string, payload: unknown, options?: Omit<RequestOptions, "threadId">): Promise<AgentMessage> {
        return this.sdk.request(to, payload, { ...options, threadId });
    }

    /** List online agents. */
    async listOnlineAgents(): Promise<AgentInfo[]> {
        return this.sdk.listOnlineAgents();
    }

    /** Thread budget status. */
    async getThreadState(threadId: string): Promise<Record<string, unknown>> {
        return this.sdk.threadStatus(threadId);
    }

    /** Load thread messages with cursor. */
    async loadThreadWindow(threadId: string, cursor?: string): Promise<Record<string, unknown>> {
        return this.sdk.getThreadMessages(threadId, { cursor });
    }

    /** Register compaction handler. */
    onCompaction(handler: CompactionHandler): void {
        this.compactionHandler = handler;
    }

    /**
     * Build a deterministic peer-to-peer thread ID.
     *
     * Convention (from agentnet-realm):
     *   Main thread:  user ↔ orchestrator  →  mainThreadId
     *   Peer thread:  agentA ↔ agentB      →  mainThreadId::sorted(a,b)::r{round}
     *
     * Example:
     *   main:  "tg_thread_7463381947"
     *   peer:  "tg_thread_7463381947::agent1_agent2::r1"
     */
    static buildPeerThreadId(mainThreadId: string, agentA: string, agentB: string, round = 1): string {
        const sorted = [agentA, agentB].sort().join("_");
        return `${mainThreadId}::${sorted}::r${round}`;
    }

    /** Escape hatch for advanced use. */
    get raw(): AgentNetClient {
        return this.sdk;
    }
}
