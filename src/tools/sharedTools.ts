/**
 * tools/sharedTools.ts — Universal tools available to all agents.
 */

import type { ToolSpec } from "./registry.js";
import { createChat } from "../protocol.js";
import { NetworkBridge } from "../networkBridge.js";
import { secrets } from "../config.js";

/**
 * Tool: chatWithAgent
 * Allows any agent to query or ping another agent on the network.
 * This does NOT assign them a formal task; it just asks a question.
 */
export const chatWithAgentTool: ToolSpec = {
    name: "chatWithAgent",
    description: "Send a message or question to another specific agent on the network. Use this to consult peers or ask questions without assigning them a formal task.",
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
        },
        required: ["targetAgentId", "message"],
    },
    execute: async (args: { targetAgentId: string; message: string }, ctx) => {
        if (!ctx.bridge || !ctx.threadId || !ctx.agentId) {
            throw new Error("Missing network context to chat with agent.");
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

        // Use the standard internal CHAT protocol type
        const payload = createChat(args.message);
        await ctx.bridge.sendMessage(args.targetAgentId, peerThreadId, payload);

        return `Message successfully sent to ${args.targetAgentId} on thread ${peerThreadId}. They will reply when ready.`;
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
