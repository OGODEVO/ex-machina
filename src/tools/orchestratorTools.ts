import type { ToolSpec } from "./registry.js";
import { createAssign, createChat, isProtocolMessage } from "../protocol.js";
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
                return `Successfully sent the answer to the user: ${args.answer}`;
            } catch (err: any) {
                console.error("[Orchestrator] Failed to send answerDirectly reply:", err);
                if (err?.code === "missing_reply_to") {
                    return "Could not send answer: no reply channel for this message (fire-and-forget internal event).";
                }
                return `Could not send answer: ${err?.message ?? String(err)}`;
            }
        }
        return "Could not send answer: missing reply function in tool context.";
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
                console.log(`[Orchestrator] Sent task to ${task.agentId} on ${peerThreadId}, waiting for terminal reply...`);
                const reply = await ctx.bridge!.requestMessage(task.agentId, peerThreadId, payload, {
                    timeoutMs: 300_000,
                });

                const protocol = parseProtocolPayload(reply.payload);
                if (!protocol) {
                    return `[Error from ${task.agentId}]:\nTask failed: invalid reply payload (expected done/blocked).\n`;
                }

                if (protocol.type === "done") {
                    return `[Result from ${task.agentId}]:\n${protocol.text}\n`;
                }
                if (protocol.type === "blocked") {
                    return `[Error from ${task.agentId}]:\nTask blocked: ${protocol.text}\n`;
                }
                if (protocol.type === "chat") {
                    return `[Result from ${task.agentId}]:\n${protocol.text}\n`;
                }

                return `[Error from ${task.agentId}]:\nTask failed: unsupported terminal payload type "${protocol.type}".\n`;
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
        const roleByAgent = buildDebateRoles(agents);

        let transcript = `DEBATE TOPIC: ${args.topic}\nPARTICIPANTS: ${agents.join(", ")}\nROUNDS: ${rounds}\n\n`;
        let conversationHistory = `You are participating in a formal debate with ${agents.length} participants. The topic is: ${args.topic}\n\n`;

        console.log(`[Orchestrator] Starting ${agents.length}-agent debate on thread ${debateThreadId}`);

        let aborted = false;
        let lastAcceptedTurnText = "";

        const requestTurn = async (speaker: string, prompt: string): Promise<string> => {
            const reply = await ctx.bridge!.requestMessage(speaker, debateThreadId, createAssign(speaker, prompt), {
                timeoutMs: 180_000,
            });
            const protocol = parseProtocolPayload(reply.payload);
            if (!protocol) throw new Error("invalid reply payload (expected done/blocked/chat)");
            if (protocol.type === "blocked") throw new Error(`Agent blocked: ${protocol.text}`);
            if (protocol.type === "done" || protocol.type === "chat") return protocol.text || "(Empty argument)";
            throw new Error(`unsupported payload type "${protocol.type}"`);
        };

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
                    prompt = `${conversationHistory}You are ${speaker}. ${roleByAgent[speaker]}\n\nYou are opening the debate. Provide your first argument.`;
                } else if (isLast) {
                    prompt = `${conversationHistory}You are ${speaker}. ${roleByAgent[speaker]}\n\nProvide your final rebuttal and closing statement.`;
                } else {
                    prompt = `${conversationHistory}You are ${speaker}. ${roleByAgent[speaker]}\n\nRespond to ${prevSpeaker}'s last point with your rebuttal.`;
                }
                prompt += `\n\nHard constraints:
- Think independently from other agents.
- Introduce at least one NEW evidence point not already in the transcript.
- Include one sentence starting with "Counterpoint:" that directly challenges a specific claim from ${prevSpeaker}.
- Do NOT copy or lightly paraphrase another agent's wording.
- Keep this turn concise (about 120-220 words).
- End with one line starting with "Position:" summarizing your stance.
- Complete the turn by calling markTaskDone with your turn text.`;

                try {
                    console.log(`[Orchestrator] Sent debate turn to ${speaker}, waiting for terminal reply...`);
                    let turnText = await requestTurn(speaker, prompt);

                    if (isLikelyMirror(turnText, lastAcceptedTurnText)) {
                        console.log(`[Orchestrator] ${speaker} produced mirrored content; requesting one independent rewrite.`);
                        const rewritePrompt = `${conversationHistory}Your previous turn was rejected because it mirrored another agent's language.\n\nYou are ${speaker}. ${roleByAgent[speaker]}\n\nRewrite your turn with independent reasoning and fresh evidence. You must disagree with one concrete claim from ${prevSpeaker} in a sentence starting with "Counterpoint:". Do not reuse sentence structure from previous turns. End with "Position: ...". Then call markTaskDone.`;
                        const retryText = await requestTurn(speaker, rewritePrompt);
                        if (!isLikelyMirror(retryText, lastAcceptedTurnText)) {
                            turnText = retryText;
                        } else {
                            turnText = `[Mirror warning: second attempt remained too similar]\n${retryText}`;
                        }
                    }

                    transcript += `**${speaker.toUpperCase()}**:\n${turnText}\n\n`;
                    conversationHistory += `\n[${speaker}]: ${turnText}\n\n`;
                    lastAcceptedTurnText = turnText;
                } catch (err: any) {
                    transcript += `**${speaker.toUpperCase()}** failed to respond: ${err.message}\n`;
                    aborted = true;
                }
            }
        }

        return `Debate finished. Here is the full transcript. Read it carefully and summarize the outcome for the user.\n\n${transcript}`;
    },
};

function parseProtocolPayload(value: unknown): any {
    if (isProtocolMessage(value)) return value;
    if (typeof value === "string") {
        try {
            return parseProtocolPayload(JSON.parse(value));
        } catch {
            return null;
        }
    }
    if (!value || typeof value !== "object") return null;
    for (const nested of Object.values(value as Record<string, unknown>)) {
        const found = parseProtocolPayload(nested);
        if (found) return found;
    }
    return null;
}

function buildDebateRoles(agents: string[]): Record<string, string> {
    if (agents.length === 2) {
        return {
            [agents[0]]: "Role: Affirmative. Defend the strongest case FOR the proposition.",
            [agents[1]]: "Role: Negative. Build the strongest case AGAINST the proposition.",
        };
    }
    if (agents.length === 3) {
        return {
            [agents[0]]: "Role: Thesis builder. Present the primary thesis and strongest supportive evidence.",
            [agents[1]]: "Role: Contrarian. Attack assumptions, contradictions, and overconfidence.",
            [agents[2]]: "Role: Risk analyst. Focus on uncertainty, downside scenarios, and failure modes.",
        };
    }
    return {
        [agents[0]]: "Role: Thesis builder. Present the primary thesis and strongest supportive evidence.",
        [agents[1]]: "Role: Contrarian. Attack assumptions, contradictions, and overconfidence.",
        [agents[2]]: "Role: Risk analyst. Focus on uncertainty, downside scenarios, and failure modes.",
        [agents[3]]: "Role: Synthesizer. Test both sides, quantify tradeoffs, and present the decision rule.",
    };
}

function isLikelyMirror(current: string, previous: string): boolean {
    const a = normalizeText(current);
    const b = normalizeText(previous);
    if (!a || !b) return false;
    if (a === b) return true;
    if (a.length > 120 && b.length > 120 && (a.includes(b) || b.includes(a))) return true;

    const similarity = jaccardSimilarity(a, b);
    const lenRatio = a.length > b.length ? a.length / b.length : b.length / a.length;
    return similarity >= 0.82 && lenRatio <= 1.35;
}

function normalizeText(input: string): string {
    return input
        .toLowerCase()
        .replace(/https?:\/\/\S+/g, " ")
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function jaccardSimilarity(a: string, b: string): number {
    const setA = new Set(a.split(" ").filter(Boolean));
    const setB = new Set(b.split(" ").filter(Boolean));
    if (setA.size === 0 || setB.size === 0) return 0;

    let intersection = 0;
    for (const token of setA) {
        if (setB.has(token)) intersection++;
    }
    const union = setA.size + setB.size - intersection;
    return union === 0 ? 0 : intersection / union;
}
