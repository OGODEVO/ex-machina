import type { ToolSpec } from "./registry.js";
import { createAssign, createChat, isProtocolMessage } from "../protocol.js";
import { NetworkBridge } from "../networkBridge.js";
import { searchWebTool } from "./searchTools.js";

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

/**
 * Tool: runAutonomousNbaPick
 * Deterministic autonomous NBA pipeline:
 *   Agent2 pre-game -> Agent3 lineups -> Orchestrator web metrics -> locked debate -> final pick card.
 */
export const runAutonomousNbaPickTool: ToolSpec = {
    name: "runAutonomousNbaPick",
    description:
        "Run a deterministic autonomous NBA pick workflow for a matchup: collect pre-game analysis from agent2, lineups from agent3, fetch web metrics, run locked debate (agent1+agent3), and return one final report card.",
    parameters: {
        type: "object",
        properties: {
            teamA: {
                type: "string",
                description: "First team name/abbr (e.g. 'Lakers', 'LAL').",
            },
            teamB: {
                type: "string",
                description: "Second team name/abbr (e.g. 'Suns', 'PHX').",
            },
            rounds: {
                type: "number",
                description: "Debate rounds (1-5). Default: 3.",
            },
        },
        required: ["teamA", "teamB"],
    },
    execute: async (args: { teamA: string; teamB: string; rounds?: number }, ctx) => {
        if (!ctx.bridge || !ctx.threadId || !ctx.agentId) {
            throw new Error("Missing network context.");
        }

        const teamA = args.teamA.trim();
        const teamB = args.teamB.trim();
        const rounds = Math.max(1, Math.min(5, args.rounds ?? 3));
        const nowIso = new Date().toISOString();
        const runId = `autonba_${Date.now()}`;

        const requestWorker = async (
            agentId: "agent1" | "agent2" | "agent3",
            instructions: string,
            timeoutMs = 240_000
        ): Promise<{ ok: boolean; text: string; error?: string }> => {
            const peerThreadId = NetworkBridge.buildPeerThreadId(ctx.threadId!, ctx.agentId!, agentId);
            try {
                const reply = await ctx.bridge!.requestMessage(
                    agentId,
                    peerThreadId,
                    createAssign(agentId, instructions),
                    { timeoutMs }
                );
                const protocol = parseProtocolPayload(reply.payload);
                if (!protocol) return { ok: false, text: "", error: `invalid payload from ${agentId}` };
                if (protocol.type === "blocked") return { ok: false, text: protocol.text ?? "", error: `blocked: ${protocol.text}` };
                if (protocol.type === "done" || protocol.type === "chat") return { ok: true, text: protocol.text ?? "" };
                return { ok: false, text: "", error: `unsupported payload type: ${protocol.type}` };
            } catch (err: any) {
                return { ok: false, text: "", error: err?.message ?? String(err) };
            }
        };

        // Phase 1: Agent 2 pre-game dossier (strict tool scope)
        const a2Instructions = [
            `AUTONOMOUS NBA MODE (${runId})`,
            `Task: Produce pre-game analysis for "${teamA}" vs "${teamB}".`,
            `Allowed tools for this phase: getDailySchedule (optional), preGameAnalysis, markTaskDone.`,
            `Do NOT use searchWeb, deepSearch, askQuestion, or chatWithAgent for this task.`,
            `Return ONLY raw preGameAnalysis payload via markTaskDone.`,
        ].join("\n");
        const agent2 = await requestWorker("agent2", a2Instructions);
        if (!agent2.ok) {
            return `[AUTONBA_FINAL]\nStatus: BLOCKED\nStage: agent2_pregame\nReason: ${agent2.error ?? "unknown"}\n`;
        }

        // Phase 2: Agent 3 lineups from Rotowire (strict tool scope)
        const a3Instructions = [
            `AUTONOMOUS NBA MODE (${runId})`,
            `Task: Fetch lineup card for "${teamA}" vs "${teamB}" from Rotowire NBA lineups.`,
            `Allowed tools for this phase: getRotowireLineups, markTaskDone.`,
            `Call getRotowireLineups with the matchup context. Prefer a matching game card for these teams.`,
            `If no matching game is found, still return the structured payload and set that finding clearly in markTaskDone.`,
            `Do NOT use deepSearch, searchWeb, scrapePage, browserAction, askQuestion, or chatWithAgent.`,
        ].join("\n");
        const agent3 = await requestWorker("agent3", a3Instructions);
        if (!agent3.ok) {
            return `[AUTONBA_FINAL]\nStatus: BLOCKED\nStage: agent3_lineups\nReason: ${agent3.error ?? "unknown"}\n`;
        }

        // Phase 3: Orchestrator web metrics (structured numeric query pack)
        const today = new Date().toLocaleDateString("en-US", {
            month: "long",
            day: "numeric",
            year: "numeric",
            timeZone: "America/Chicago",
        });
        const metricsPlan: MetricQueryPlan[] = [
            {
                key: "odds",
                label: "Market Odds",
                query: `${teamA} vs ${teamB} betting odds spread moneyline over under today ${today}`,
            },
            {
                key: "ats_team_a",
                label: `${teamA} ATS Profile`,
                query: `${teamA} against the spread ATS record 2025-26 season and last 10 games`,
            },
            {
                key: "ats_team_b",
                label: `${teamB} ATS Profile`,
                query: `${teamB} against the spread ATS record 2025-26 season and last 10 games`,
            },
            {
                key: "last10_team_a",
                label: `${teamA} Last-10 Form`,
                query: `${teamA} last 10 games record points per game points allowed net rating 2025-26`,
            },
            {
                key: "last10_team_b",
                label: `${teamB} Last-10 Form`,
                query: `${teamB} last 10 games record points per game points allowed net rating 2025-26`,
            },
            {
                key: "home_away_team_a",
                label: `${teamA} Home/Away Splits`,
                query: `${teamA} home record away record home points per game away points per game 2025-26`,
            },
            {
                key: "home_away_team_b",
                label: `${teamB} Home/Away Splits`,
                query: `${teamB} home record away record home points per game away points per game 2025-26`,
            },
            {
                key: "h2h_last3",
                label: "Head-to-Head Last 3",
                query: `${teamA} vs ${teamB} last 3 games scores and ATS results`,
            },
        ];

        const metricResults: MetricQueryResult[] = await Promise.all(metricsPlan.map(async (plan) => {
            const output = String(await searchWebTool.execute({
                query: plan.query,
                maxResults: 4,
            }, ctx));
            return {
                key: plan.key,
                label: plan.label,
                query: plan.query,
                output,
                ok: !looksLikeSearchFailure(output),
            };
        }));

        const hardFailures = metricResults.filter((m) => !m.ok);
        if (hardFailures.length > 0) {
            return [
                `[AUTONBA_FINAL]`,
                `Status: BLOCKED`,
                `Stage: web_metrics`,
                `Reason: One or more metric queries failed.`,
                ...hardFailures.map((m) => `- ${m.label}: ${m.output}`),
            ].join("\n");
        }

        const webMetrics = [
            `Structured Web Metrics (${today})`,
            ...metricResults.map((m) => [
                ``,
                `### ${m.label}`,
                `Query: ${m.query}`,
                m.output,
            ].join("\n")),
        ].join("\n");

        const mergedDossier = [
            `AUTONOMOUS NBA REPORT SHEET`,
            `Run ID: ${runId}`,
            `Generated At: ${nowIso}`,
            `Matchup: ${teamA} vs ${teamB}`,
            ``,
            `=== SECTION A: AGENT2 PRE-GAME ANALYSIS (RAW) ===`,
            agent2.text,
            ``,
            `=== SECTION B: AGENT3 LINEUPS (RAW) ===`,
            agent3.text,
            ``,
            `=== SECTION C: WEB METRICS (RAW) ===`,
            String(webMetrics),
        ].join("\n");

        const missing: string[] = [];
        const lower = mergedDossier.toLowerCase();
        if (!lower.includes("pre-game analysis dossier")) missing.push("pregame_dossier");
        if (!lower.includes("lineup")) missing.push("lineups");
        const metricsByKey = Object.fromEntries(metricResults.map((m) => [m.key, m]));
        if (!hasOddsNumbers(metricsByKey.odds?.output ?? "")) missing.push("odds_numeric");
        if (!hasAtsNumbers(metricsByKey.ats_team_a?.output ?? "")) missing.push(`${teamA}_ats_numeric`);
        if (!hasAtsNumbers(metricsByKey.ats_team_b?.output ?? "")) missing.push(`${teamB}_ats_numeric`);
        if (!hasLast10Numbers(metricsByKey.last10_team_a?.output ?? "")) missing.push(`${teamA}_last10_numeric`);
        if (!hasLast10Numbers(metricsByKey.last10_team_b?.output ?? "")) missing.push(`${teamB}_last10_numeric`);
        if (!hasHomeAwayNumbers(metricsByKey.home_away_team_a?.output ?? "")) missing.push(`${teamA}_home_away_numeric`);
        if (!hasHomeAwayNumbers(metricsByKey.home_away_team_b?.output ?? "")) missing.push(`${teamB}_home_away_numeric`);
        if (!hasH2HNumbers(metricsByKey.h2h_last3?.output ?? "")) missing.push("h2h_last3_numeric");

        if (missing.length > 0) {
            return [
                `[AUTONBA_FINAL]`,
                `Status: BLOCKED`,
                `Stage: validation`,
                `Missing: ${missing.join(", ")}`,
                ``,
                `Partial Report Sheet:`,
                mergedDossier,
            ].join("\n");
        }

        // Phase 4: Locked debate (no external tools)
        const debateThreadId = `debate_${Date.now()}`;
        const debaters: Array<"agent1" | "agent3"> = ["agent1", "agent3"];
        let transcript = `DEBATE TOPIC: ${teamA} vs ${teamB}\nROUNDS: ${rounds}\nPARTICIPANTS: ${debaters.join(", ")}\n\n`;
        let history = `Use ONLY the report sheet below. Do NOT add outside facts.\n\n${mergedDossier}\n\n`;

        const requestDebateTurn = async (speaker: "agent1" | "agent3", prompt: string): Promise<string> => {
            const reply = await ctx.bridge!.requestMessage(
                speaker,
                debateThreadId,
                createAssign(speaker, prompt),
                { timeoutMs: 180_000 }
            );
            const protocol = parseProtocolPayload(reply.payload);
            if (!protocol) throw new Error(`invalid payload from ${speaker}`);
            if (protocol.type === "blocked") throw new Error(`blocked: ${protocol.text}`);
            if (protocol.type === "done" || protocol.type === "chat") return protocol.text || "(Empty)";
            throw new Error(`unsupported payload type: ${protocol.type}`);
        };

        try {
            for (let r = 1; r <= rounds; r++) {
                transcript += `--- ROUND ${r} ---\n`;
                for (let i = 0; i < debaters.length; i++) {
                    const speaker = debaters[i];
                    const other = debaters[(i + 1) % debaters.length];
                    const prompt = [
                        history,
                        `You are ${speaker}.`,
                        `Debate target: pick best angle for ${teamA} vs ${teamB}.`,
                        `Hard rules:`,
                        `- Use ONLY numbers/facts in the report sheet.`,
                        `- Do NOT call tools except markTaskDone.`,
                        `- Include one line starting with "Position:".`,
                        `- Keep concise (120-220 words).`,
                        `- End by calling markTaskDone with your turn.`,
                        i === 0 ? `Counterpoint requirement: challenge ${other}'s prior claim.` : `Counterpoint requirement: directly rebut ${other}.`,
                    ].join("\n");
                    const turn = await requestDebateTurn(speaker, prompt);
                    transcript += `**${speaker.toUpperCase()}**:\n${turn}\n\n`;
                    history += `\n[${speaker}] ${turn}\n`;
                }
            }
        } catch (err: any) {
            return [
                `[AUTONBA_FINAL]`,
                `Status: BLOCKED`,
                `Stage: debate`,
                `Reason: ${err?.message ?? String(err)}`,
                ``,
                `Merged Report Sheet:`,
                mergedDossier,
            ].join("\n");
        }

        const positions = Array.from(transcript.matchAll(/Position:\s*(.+)$/gim)).map((m) => m[1].trim());
        const finalPosition = positions.length > 0 ? positions[positions.length - 1] : "No explicit final position extracted.";

        return [
            `[AUTONBA_FINAL]`,
            `Status: DONE`,
            `Run ID: ${runId}`,
            `Matchup: ${teamA} vs ${teamB}`,
            ``,
            `=== MERGED REPORT SHEET ===`,
            mergedDossier,
            ``,
            `=== DEBATE TRANSCRIPT ===`,
            transcript,
            `=== FINAL PICK ===`,
            finalPosition,
        ].join("\n");
    },
};

type MetricQueryKey =
    | "odds"
    | "ats_team_a"
    | "ats_team_b"
    | "last10_team_a"
    | "last10_team_b"
    | "home_away_team_a"
    | "home_away_team_b"
    | "h2h_last3";

interface MetricQueryPlan {
    key: MetricQueryKey;
    label: string;
    query: string;
}

interface MetricQueryResult extends MetricQueryPlan {
    output: string;
    ok: boolean;
}

function looksLikeSearchFailure(text: string): boolean {
    const lower = text.toLowerCase().trim();
    return (
        lower.startsWith("error:")
        || lower.startsWith("search failed")
        || lower.startsWith("deep search failed")
        || lower.includes("api key is not set")
        || lower.includes("circuit-breaker")
        || lower.includes("timed out")
    );
}

function hasRecordPair(text: string): boolean {
    return /\b\d{1,2}\s*-\s*\d{1,2}\b/.test(text);
}

function hasScorePair(text: string): boolean {
    return /\b\d{2,3}\s*-\s*\d{2,3}\b/.test(text);
}

function hasOddsNumbers(text: string): boolean {
    const lower = text.toLowerCase();
    const hasOddsTerms = /odds|spread|moneyline|over\/under|total|line/i.test(text);
    const hasOddsNumeric = /[+-]\d{1,4}|\b\d{2,3}(?:\.\d+)?\b/.test(text);
    return hasOddsTerms && hasOddsNumeric && !looksLikeSearchFailure(lower);
}

function hasAtsNumbers(text: string): boolean {
    const hasAtsTerm = /\bats\b|against the spread/i.test(text);
    return hasAtsTerm && hasRecordPair(text) && !looksLikeSearchFailure(text);
}

function hasLast10Numbers(text: string): boolean {
    const hasLast10Term = /last 10|last ten/i.test(text);
    const hasPerformanceTerms = /\bppg\b|points|allowed|net rating|offensive rating|defensive rating/i.test(text);
    return hasLast10Term && (hasRecordPair(text) || hasScorePair(text)) && hasPerformanceTerms && !looksLikeSearchFailure(text);
}

function hasHomeAwayNumbers(text: string): boolean {
    const hasSplitTerms = /\bhome\b/i.test(text) && /\baway\b/i.test(text);
    const hasNumeric = hasRecordPair(text) || /\b\d{2,3}(?:\.\d+)?%?\b/.test(text);
    return hasSplitTerms && hasNumeric && !looksLikeSearchFailure(text);
}

function hasH2HNumbers(text: string): boolean {
    const hasH2hTerms = /head to head|h2h|matchup/i.test(text);
    const hasLast3 = /last 3|last three/i.test(text);
    const hasGameNumbers = hasScorePair(text) || hasRecordPair(text);
    return hasH2hTerms && hasLast3 && hasGameNumbers && !looksLikeSearchFailure(text);
}

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
