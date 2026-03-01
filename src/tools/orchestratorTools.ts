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
        if (ctx.reply) {
            try {
                // Send the answer directly to the user
                await ctx.reply(createChat(args.answer));
            } catch (err: any) {
                console.error("[Orchestrator] Failed to send answerDirectly reply:", err);
            }
        }
        return `Successfully sent the answer to the user: ${args.answer}`;
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
        if (!ctx.bridge || !ctx.threadId || !ctx.agentId) {
            throw new Error("Missing network context to send assignment messages.");
        }

        let resultLog = `Dispatched ${args.assignments.length} tasks and collected results:\n\n`;

        const promises = args.assignments.map(async (task) => {
            const peerThreadId = NetworkBridge.buildPeerThreadId(
                ctx.threadId!, ctx.agentId!, task.agentId
            );

            const payload = createAssign(task.agentId, task.instructions);
            try {
                // Send the assignment (fire-and-forget)
                await ctx.bridge!.sendMessage(task.agentId, peerThreadId, payload);
                console.log(`[Orchestrator] Sent task to ${task.agentId} on ${peerThreadId}, waiting for DONE...`);

                // Poll the thread history waiting for a DONE or BLOCKED message from the agent
                const timeoutMs = 300_000; // 5 minutes max
                const pollIntervalMs = 5000;
                const startTime = Date.now();

                while (Date.now() - startTime < timeoutMs) {
                    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));

                    const history = await ctx.bridge!.loadThreadWindow(peerThreadId);
                    if (history && Array.isArray(history.messages)) {
                        // Look for the most recent DONE or BLOCKED message from the assigned agent
                        for (let i = history.messages.length - 1; i >= 0; i--) {
                            const msg = history.messages[i];
                            const sender = msg.from_username || msg.from_agent || msg.sender_id || "";

                            // Debug logging to see what messages are flying by

                            let parsedPayload: any = null;
                            if (typeof msg.payload === "string") {
                                try { parsedPayload = JSON.parse(msg.payload); } catch (e) { }
                            } else if (typeof msg.payload === "object") {
                                parsedPayload = msg.payload;
                            }

                            // Helper function to recursively search for a matching payload type
                            const findPayloadType = (obj: any, targetType: string): any => {
                                if (!obj || typeof obj !== "object") return null;
                                if (obj.type === targetType) return obj;

                                for (const key in obj) {
                                    if (Object.prototype.hasOwnProperty.call(obj, key)) {
                                        const result = findPayloadType(obj[key], targetType);
                                        if (result) return result;
                                    }
                                }
                                return null;
                            };

                            if (parsedPayload) {
                                const doneMsg = findPayloadType(parsedPayload, "done");
                                if (doneMsg) {
                                    return `[Result from ${task.agentId}]:\n${doneMsg.text}\n`;
                                }
                                const blockedMsg = findPayloadType(parsedPayload, "blocked");
                                if (blockedMsg) {
                                    return `[Error from ${task.agentId}]:\nTask blocked: ${blockedMsg.text}\n`;
                                }
                            }
                        }
                    }
                }

                return `[Error from ${task.agentId}]:\nTask failed: TIMEOUT after 5 minutes.\n`;
            } catch (err: any) {
                return `[Error from ${task.agentId}]:\nTask failed: ${err.message}\n`;
            }
        });

        const results = await Promise.all(promises);
        resultLog += results.join("\n");

        return resultLog;
    },
};

/**
 * Tool: facilitateDebate
 * Coordinates a multi-round debate or discussion between N agents (2-4).
 * Agents speak in round-robin order. The Orchestrator waits for the full transcript.
 */
export const facilitateDebateTool: ToolSpec = {
    name: "facilitateDebate",
    description: "Facilitate a structured debate between 2-4 agents on a specific topic. Agents speak in round-robin order for the specified number of rounds. Returns the full transcript.",
    parameters: {
        type: "object",
        properties: {
            topic: {
                type: "string",
                description: "The topic, statement, or research material they should debate.",
            },
            agents: {
                type: "array",
                items: {
                    type: "string",
                    enum: ["agent1", "agent2", "agent3"],
                },
                description: "Array of 2-4 agent IDs to participate, in speaking order. Example: ['agent1', 'agent3'] or ['agent1', 'agent2', 'agent3'].",
            },
            rounds: {
                type: "number",
                description: "How many full rounds (1 to 5). Each round gives every agent one turn to speak.",
            },
        },
        required: ["topic", "agents", "rounds"],
    },
    execute: async (args: { topic: string; agents: string[]; rounds: number }, ctx) => {
        if (!ctx.bridge || !ctx.threadId) {
            throw new Error("Missing network context.");
        }

        const agents = args.agents;
        if (agents.length < 2) return "Error: Need at least 2 agents for a debate.";
        if (agents.length > 4) return "Error: Maximum 4 agents per debate.";
        if (new Set(agents).size !== agents.length) return "Error: Duplicate agents not allowed.";

        const rounds = Math.max(1, Math.min(5, args.rounds));
        const debateThreadId = `debate_${Date.now()}`;

        let transcript = `DEBATE TOPIC: ${args.topic}\nPARTICIPANTS: ${agents.join(", ")}\nROUNDS: ${rounds}\n\n`;
        let conversationHistory = `You are participating in a formal debate with ${agents.length} participants. The topic is: ${args.topic}\n\n`;

        console.log(`[Orchestrator] Starting ${agents.length}-agent debate on thread ${debateThreadId}`);

        let aborted = false;

        for (let r = 1; r <= rounds && !aborted; r++) {
            transcript += `--- ROUND ${r} ---\n`;
            console.log(`[Orchestrator] Debate Round ${r}/${rounds}`);

            for (let i = 0; i < agents.length && !aborted; i++) {
                const speaker = agents[i];
                const isFirst = r === 1 && i === 0;
                const isLast = r === rounds && i === agents.length - 1;
                const prevSpeaker = i > 0 ? agents[i - 1] : agents[agents.length - 1];

                let prompt: string;
                if (isFirst) {
                    prompt = `${conversationHistory}You are ${speaker}. Please provide your opening argument.`;
                } else if (isLast) {
                    prompt = `${conversationHistory}You are ${speaker}. Please provide your final rebuttal and closing statement.`;
                } else {
                    prompt = `${conversationHistory}You are ${speaker}. Please respond to ${prevSpeaker}'s last point with your rebuttal.`;
                }

                try {
                    // Send the debate prompt (fire-and-forget)
                    await ctx.bridge.sendMessage(speaker, debateThreadId, createAssign(speaker, prompt));
                    console.log(`[Orchestrator] Sent debate turn to ${speaker}, waiting for DONE...`);

                    // Poll thread history waiting for the agent to finish their turn
                    const timeoutMs = 180_000; // 3 minutes per turn
                    const pollIntervalMs = 5000;
                    const startTime = Date.now();
                    let turnText = null;

                    while (Date.now() - startTime < timeoutMs) {
                        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));

                        const history = await ctx.bridge.loadThreadWindow(debateThreadId);
                        if (history && Array.isArray(history.messages)) {
                            for (let j = history.messages.length - 1; j >= 0; j--) {
                                const msg = history.messages[j];
                                const msgSender = msg.from_username || msg.from_agent || msg.sender_id || "";

                                // Debate threads are still isolated peer-to-peer per speaker request

                                let parsedPayload: any = null;
                                if (typeof msg.payload === "string") {
                                    try { parsedPayload = JSON.parse(msg.payload); } catch (e) { }
                                } else if (typeof msg.payload === "object") {
                                    parsedPayload = msg.payload;
                                }

                                // Helper function to recursively search for a matching payload type
                                const findPayloadType = (obj: any, targetType: string): any => {
                                    if (!obj || typeof obj !== "object") return null;
                                    if (obj.type === targetType) return obj;

                                    for (const key in obj) {
                                        if (Object.prototype.hasOwnProperty.call(obj, key)) {
                                            const result = findPayloadType(obj[key], targetType);
                                            if (result) return result;
                                        }
                                    }
                                    return null;
                                };

                                if (parsedPayload) {
                                    const doneMsg = findPayloadType(parsedPayload, "done");
                                    if (doneMsg) {
                                        turnText = doneMsg.text || "(Empty argument)";
                                        break;
                                    }
                                    const blockedMsg = findPayloadType(parsedPayload, "blocked");
                                    if (blockedMsg) {
                                        turnText = `(Agent blocked: ${blockedMsg.text})`;
                                        break;
                                    }
                                }
                            }
                        }
                        if (turnText !== null) break;
                    }

                    if (turnText === null) {
                        throw new Error("TIMEOUT waiting for debate turn");
                    }

                    transcript += `**${speaker.toUpperCase()}**:\n${turnText}\n\n`;
                    conversationHistory += `\n[${speaker}]: ${turnText}\n\n`;
                } catch (err: any) {
                    transcript += `**${speaker.toUpperCase()}** failed to respond: ${err.message}\n`;
                    aborted = true;
                }
            }
        }

        return `Debate finished. Here is the full transcript. Read it carefully and summarize the outcome for the user.\n\n${transcript}`;
    },
};

// Small helper to pull text out of an unknown payload wrapper
function extractText(payload: unknown): string | null {
    if (typeof payload === "string") return payload;
    if (typeof payload === "object" && payload !== null && "text" in payload) {
        return String((payload as any).text);
    }
    return null;
}

