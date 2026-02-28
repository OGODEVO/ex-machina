import type { ToolSpec } from "./registry.js";
import { createAssign, createChat } from "../protocol.js";
import { NetworkBridge } from "../networkBridge.js";

/**
 * Tool: answerDirectly
 * For simple factual questions that don't require workers.
 */
export const answerDirectlyTool: ToolSpec = {
    name: "answerDirectly",
    description: "Use this to respond directly to the user for simple queries. Do NOT use this if the task requires writing code or deep research — you must assign those tasks instead.",
    parameters: {
        type: "object",
        properties: {
            answer: {
                type: "string",
                description: "Your direct, final answer to the user.",
            },
        },
        required: ["answer"],
    },
    execute: async (args: { answer: string }, ctx) => {
        return `[System] Answer ready for User: ${args.answer}`;
    },
};

/**
 * Tool: assignTasks
 * For breaking down complex work and assigning it out.
 * Uses peer thread IDs so worker conversations are separate from the main user thread.
 */
export const assignTasksTool: ToolSpec = {
    name: "assignTasks",
    description: "Break a complex goal into sub-tasks and assign them to specialized agents (agent1, agent2, agent3).",
    parameters: {
        type: "object",
        properties: {
            assignments: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        agentId: {
                            type: "string",
                            enum: ["agent1", "agent2", "agent3"],
                            description: "The agent to assign this to.",
                        },
                        instructions: {
                            type: "string",
                            description: "Specific details on what you want them to do.",
                        },
                    },
                    required: ["agentId", "instructions"],
                },
            },
        },
        required: ["assignments"],
    },
    execute: async (args: { assignments: Array<{ agentId: string; instructions: string }> }, ctx) => {
        if (!ctx.bridge || !ctx.threadId) {
            throw new Error("Missing network context to send assignment messages.");
        }

        let resultLog = `Dispatched ${args.assignments.length} tasks:\n`;

        for (const task of args.assignments) {
            // Build a peer thread ID: mainThread::orchestrator_agent1::r1
            const peerThreadId = NetworkBridge.buildPeerThreadId(
                ctx.threadId, ctx.agentId, task.agentId
            );

            const payload = createAssign(task.agentId, task.instructions);
            await ctx.bridge.sendMessage(task.agentId, peerThreadId, payload);
            resultLog += `- Sent to ${task.agentId} on thread ${peerThreadId}: "${task.instructions}"\n`;
        }

        return resultLog;
    },
};
