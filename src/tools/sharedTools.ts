/**
 * tools/sharedTools.ts — Universal tools available to all agents.
 */

import type { ToolSpec } from "./registry.js";
import { createChat, isProtocolMessage } from "../protocol.js";
import { NetworkBridge } from "../networkBridge.js";
import { secrets } from "../config.js";

/**
 * Tool: chatWithAgent
 * Allows any agent to query or ping another agent on the network.
 * This does NOT assign them a formal task; it just asks a question.
 */
export const chatWithAgentTool: ToolSpec = {
    name: "chatWithAgent",
    description: "Send a message or question to another specific agent on the network. By default, the Orchestrator waits for the peer's direct reply so it can answer the user in the same turn.",
    parameters: {
        type: "object",
        properties: {
            targetAgentId: {
                type: "string",
                description: `The ID of the agent you want to talk to. Examples: "${secrets.orchestratorId}", "agent1", "agent2", "agent3".`,
            },
            message: {
                type: "string",
                description: "The message or question to send.",
            },
            waitForReply: {
                type: "boolean",
                description: "If true, wait for a direct reply from the target agent and return it immediately.",
            },
            timeoutMs: {
                type: "number",
                description: "Optional timeout when waitForReply=true.",
            },
        },
        required: ["targetAgentId", "message"],
    },
    execute: async (args: { targetAgentId: string; message: string; waitForReply?: boolean; timeoutMs?: number }, ctx) => {
        if (!ctx.bridge || !ctx.threadId || !ctx.agentId) {
            throw new Error("Missing network context to chat with agent.");
        }

        if (
            ctx.agentId !== secrets.orchestratorId
            && args.targetAgentId === secrets.orchestratorId
            && ctx.hasReplyChannel === true
        ) {
            return "Error: Direct reply channel is available in this turn. Do not call chatWithAgent back to Orchestrator; respond directly (or use markTaskDone/reportError for assigned work).";
        }

        if (args.targetAgentId === ctx.agentId) {
            return "Error: You cannot chat with yourself.";
        }

        // Isolate this conversation on a deterministic peer thread
        const peerThreadId = NetworkBridge.buildPeerThreadId(
            ctx.threadId,
            ctx.agentId,
            args.targetAgentId
        );

        // Use the standard internal CHAT protocol type, stamping who it's from
        const payload = createChat(args.message, ctx.agentId);
        const waitForReply = args.waitForReply ?? (ctx.agentId === secrets.orchestratorId);

        if (!waitForReply) {
            await ctx.bridge.sendMessage(args.targetAgentId, peerThreadId, payload);
            return `Message successfully sent to ${args.targetAgentId} on thread ${peerThreadId}. They will reply when ready.`;
        }

        const timeoutMs = typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs)
            ? Math.max(1000, Math.floor(args.timeoutMs))
            : 75_000;

        let reply;
        try {
            reply = await ctx.bridge.requestMessage(
                args.targetAgentId,
                peerThreadId,
                payload,
                { timeoutMs }
            );
        } catch (err: any) {
            const message = String(err?.message ?? err ?? "unknown error");
            if (message.toUpperCase().includes("TIMEOUT")) {
                return `No reply from ${args.targetAgentId} within ${timeoutMs}ms on thread ${peerThreadId}.`;
            }
            throw err;
        }

        const responseText = isProtocolMessage(reply.payload)
            ? `[${reply.payload.type.toUpperCase()}] ${reply.payload.text}`
            : typeof reply.payload === "string"
                ? reply.payload
                : JSON.stringify(reply.payload);

        return `Reply from ${args.targetAgentId} on thread ${peerThreadId}:\n${responseText}`;
    },
};

/**
 * Tool: discoverAgents
 * Allows an agent to scan the network and see who is online and what they can do.
 */
export const discoverAgentsTool: ToolSpec = {
    name: "discoverAgents",
    description: "Queries the network registry to discover all currently online agents and their capabilities. Use this to find out who you can assign tasks to or chat with.",
    parameters: {
        type: "object",
        properties: {},
        required: [],
    },
    execute: async (_args: {}, ctx) => {
        if (!ctx.bridge) {
            throw new Error("Missing network context to discover agents.");
        }

        const onlineAgents = await ctx.bridge.listOnlineAgents();

        if (onlineAgents.length === 0) {
            return "No other agents are currently online.";
        }

        // Format the output so the LLM can easily read it
        const formattedList = onlineAgents.map((a: any) => {
            const isMe = a.agent_id === ctx.agentId ? "(You) " : "";
            const caps = a.capabilities && a.capabilities.length > 0
                ? `Capabilities: [${a.capabilities.join(", ")}]`
                : "No specific capabilities listed.";
            return `- **${a.name}** (ID: \`${a.agent_id}\`) ${isMe}\n  ${caps}`;
        }).join("\n\n");

        return `Currently online agents on AgentNet:\n\n${formattedList}`;
    },
};

/**
 * Tool: endConversation
 * Allows an agent to cleanly hang up the chat without replying.
 */
export const endConversationTool: ToolSpec = {
    name: "endConversation",
    description: "Call this tool ONLY when a peer-to-peer chat has naturally concluded and no further reply or thank you is needed. This will cleanly hang up the conversation.",
    parameters: {
        type: "object",
        properties: {},
        required: [],
    },
    execute: async (_args: {}, _ctx) => {
        return "Successfully ended the conversation.";
    },
};
