import type { ToolSpec } from "./registry.js";
import { createAssign, createChat, isProtocolMessage } from "../protocol.js";
import { NetworkBridge } from "../networkBridge.js";
import { searchWebTool } from "./searchTools.js";
import { resolve, relative } from "node:path";

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
                query: `${teamA} vs ${teamB} betting odds spread moneyline over under 2025-26 NBA today ${today}`,
            },
            {
                key: "ats_team_a",
                label: `${teamA} ATS Profile`,
                query: `${teamA} against the spread ATS record 2025-26 NBA season and last 10 games`,
            },
            {
                key: "ats_team_b",
                label: `${teamB} ATS Profile`,
                query: `${teamB} against the spread ATS record 2025-26 NBA season and last 10 games`,
            },
            {
                key: "last10_team_a",
                label: `${teamA} Last-10 Form`,
                query: `${teamA} last 10 games record points per game points allowed net rating 2025-26 NBA`,
            },
            {
                key: "last10_team_b",
                label: `${teamB} Last-10 Form`,
                query: `${teamB} last 10 games record points per game points allowed net rating 2025-26 NBA`,
            },
            {
                key: "home_away_team_a",
                label: `${teamA} Home/Away Splits`,
                query: `${teamA} home record away record home points per game away points per game 2025-26 NBA`,
            },
            {
                key: "home_away_team_b",
                label: `${teamB} Home/Away Splits`,
                query: `${teamB} home record away record home points per game away points per game 2025-26 NBA`,
            },
            {
                key: "h2h_last3",
                label: "Head-to-Head Last 3",
                query: `${teamA} vs ${teamB} last 3 games scores and ATS results 2025-26 NBA season`,
            },
        ];

        const metricResults: MetricQueryResult[] = await Promise.all(metricsPlan.map(async (plan) => {
            const output = stripStaleSeasonLines(String(await searchWebTool.execute({
                query: plan.query,
                maxResults: 4,
            }, ctx)));
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
        if (!hasCurrentSeasonSignal(metricsByKey.ats_team_a?.output ?? "")) missing.push(`${teamA}_ats_season_2025_26`);
        if (!hasCurrentSeasonSignal(metricsByKey.ats_team_b?.output ?? "")) missing.push(`${teamB}_ats_season_2025_26`);
        if (!hasCurrentSeasonSignal(metricsByKey.last10_team_a?.output ?? "")) missing.push(`${teamA}_last10_season_2025_26`);
        if (!hasCurrentSeasonSignal(metricsByKey.last10_team_b?.output ?? "")) missing.push(`${teamB}_last10_season_2025_26`);
        if (!hasCurrentSeasonSignal(metricsByKey.home_away_team_a?.output ?? "")) missing.push(`${teamA}_home_away_season_2025_26`);
        if (!hasCurrentSeasonSignal(metricsByKey.home_away_team_b?.output ?? "")) missing.push(`${teamB}_home_away_season_2025_26`);

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
        const turnsByAgent: Record<"agent1" | "agent3", string[]> = {
            agent1: [],
            agent3: [],
        };

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
                        `- Debate to DISCOVER the best pick, not to stubbornly defend your first take.`,
                        `- Include one line starting with "Position:".`,
                        `- Include one line starting with "Updated Insight:" that reflects what you learned from the other agent.`,
                        `- End with this exact block:`,
                        `FINAL_PICK: <single pick>`,
                        `CONFIDENCE: <0-100>`,
                        `EVIDENCE_1: <fact from sheet>`,
                        `EVIDENCE_2: <fact from sheet>`,
                        `EVIDENCE_3: <fact from sheet>`,
                        `- Keep concise (120-220 words).`,
                        `- End by calling markTaskDone with your turn.`,
                        i === 0 ? `Counterpoint requirement: challenge ${other}'s prior claim.` : `Counterpoint requirement: directly rebut ${other}.`,
                    ].join("\n");
                    const turn = await requestDebateTurn(speaker, prompt);
                    transcript += `**${speaker.toUpperCase()}**:\n${turn}\n\n`;
                    history += `\n[${speaker}] ${turn}\n`;
                    turnsByAgent[speaker].push(turn);
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

        const vote1 = parseDebateVote("agent1", turnsByAgent.agent1.at(-1) ?? "", teamA, teamB);
        const vote3 = parseDebateVote("agent3", turnsByAgent.agent3.at(-1) ?? "", teamA, teamB);
        const orchestratorVote = computeOrchestratorVote(vote1, vote3);
        const tally = tallyVotes(vote1, vote3, orchestratorVote);
        const finalPick = resolveFinalPick(tally.winnerKey, vote1, vote3, orchestratorVote);
        const tallyText = Array.from(tally.counts.entries())
            .map(([k, v]) => `${k}=${v}`)
            .join(", ");
        const votingSummary = [
            `Agent1 vote: ${vote1.pick} (confidence ${vote1.confidence})`,
            `Agent3 vote: ${vote3.pick} (confidence ${vote3.confidence})`,
            `Orchestrator vote: ${orchestratorVote.pick} (${orchestratorVote.reason})`,
            `Vote tally: ${tallyText}`,
        ].join("\n");

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
            ``,
            `=== VOTING SUMMARY ===`,
            votingSummary,
            `=== FINAL PICK ===`,
            finalPick,
        ].join("\n");
    },
};

/**
 * Tool: runAutonomousCode
 * Deterministic autonomous coding pipeline:
 *   Worker planning -> non-overlapping ownership -> worker implementation -> Agent1 integration/checks.
 */
export const runAutonomousCodeTool: ToolSpec = {
    name: "runAutonomousCode",
    description:
        "Run a deterministic autonomous coding workflow for a target workspace inside this repo: plan, assign non-overlapping work to agents, integrate with Agent1, run checks, and return a final build report.",
    parameters: {
        type: "object",
        properties: {
            goal: {
                type: "string",
                description: "What to build, change, or fix.",
            },
            workspacePath: {
                type: "string",
                description: "Absolute or repo-relative path to the target coding workspace. Must be under the current project root.",
            },
        },
        required: ["goal"],
    },
    execute: async (args: { goal: string; workspacePath?: string }, ctx) => {
        if (!ctx.bridge || !ctx.threadId || !ctx.agentId) {
            throw new Error("Missing network context.");
        }

        const goal = args.goal.trim();
        const projectRoot = process.cwd();
        const workspacePath = resolve(projectRoot, args.workspacePath?.trim() || "workspace/autocode");
        if (!isPathWithinRoot(workspacePath, projectRoot)) {
            return [
                `[AUTOCODE_FINAL]`,
                `Status: BLOCKED`,
                `Stage: setup`,
                `Reason: workspacePath must stay inside the project root.`,
                `Workspace: ${workspacePath}`,
            ].join("\n");
        }

        const runId = `autocode_${Date.now()}`;
        const relativeWorkspace = relative(projectRoot, workspacePath) || ".";

        const requestWorker = async (
            agentId: "agent1" | "agent2" | "agent3",
            instructions: string,
            timeoutMs = 600_000
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

        const planningInstructions = (agentId: "agent2" | "agent3", role: string) => [
            `AUTOCODE MODE (${runId})`,
            `Goal: ${goal}`,
            `Workspace: ${workspacePath}`,
            `Role: ${role}`,
            `This is a PLANNING pass only. Do NOT edit files yet.`,
            `Use runTerminalCommand to inspect the repo and understand structure.`,
            `Prefer rg, ls, cat, npm, node, git status. Keep it lightweight.`,
            `Return EXACTLY this format via markTaskDone:`,
            `PLAN_ROLE: <one line>`,
            `OWNED_PATHS:`,
            `- <path>`,
            `- <path>`,
            `CHECKS:`,
            `- <command>`,
            `- <command>`,
            `NOTES:`,
            `- <note>`,
            `- <note>`,
        ].join("\n");

        const plan2 = await requestWorker("agent2", planningInstructions("agent2", "implementation planner"));
        const plan3 = await requestWorker("agent3", planningInstructions("agent3", "test/review/runtime planner"));
        if (!plan2.ok || !plan3.ok) {
            return [
                `[AUTOCODE_FINAL]`,
                `Status: BLOCKED`,
                `Stage: planning`,
                `Agent2: ${plan2.ok ? "ok" : plan2.error}`,
                `Agent3: ${plan3.ok ? "ok" : plan3.error}`,
            ].join("\n");
        }

        const ownership = resolveAutocodeOwnership(workspacePath, plan2.text, plan3.text);

        const implInstructions = (
            agentId: "agent2" | "agent3",
            ownedPaths: string[],
            peerPlan: string
        ) => [
            `AUTOCODE MODE (${runId})`,
            `Goal: ${goal}`,
            `Workspace: ${workspacePath}`,
            `Your owned paths:`,
            ...ownedPaths.map((p) => `- ${p}`),
            `Hard rules:`,
            `- You may edit ONLY your owned paths.`,
            `- Use runTerminalCommand in workspace cwd: ${workspacePath}`,
            `- If you need to touch another file, use reportError instead of freelancing.`,
            `- Keep changes scoped to your owned area.`,
            `Peer planning context:`,
            peerPlan,
            `Return EXACTLY this format via markTaskDone:`,
            `STATUS: DONE`,
            `CHANGED_FILES:`,
            `- <path>`,
            `CHECKS_RUN:`,
            `- <command> => <status>`,
            `SUMMARY:`,
            `<short summary>`,
        ].join("\n");

        const impl2 = await requestWorker("agent2", implInstructions("agent2", ownership.agent2, plan3.text));
        const impl3 = await requestWorker("agent3", implInstructions("agent3", ownership.agent3, plan2.text));
        if (!impl2.ok || !impl3.ok) {
            return [
                `[AUTOCODE_FINAL]`,
                `Status: BLOCKED`,
                `Stage: implementation`,
                `Agent2: ${impl2.ok ? "ok" : impl2.error}`,
                `Agent3: ${impl3.ok ? "ok" : impl3.error}`,
                ``,
                `=== PLAN AGENT2 ===`,
                plan2.text,
                ``,
                `=== PLAN AGENT3 ===`,
                plan3.text,
            ].join("\n");
        }

        const integrateInstructions = [
            `AUTOCODE MODE (${runId})`,
            `Goal: ${goal}`,
            `Workspace: ${workspacePath}`,
            `You are the integrator.`,
            `Agent2 completed scoped work. Agent3 completed scoped work.`,
            `Your job: inspect their reported changes, integrate glue code, run checks, fix obvious integration issues, and return final status.`,
            `Agent2 plan/result:`,
            plan2.text,
            impl2.text,
            `Agent3 plan/result:`,
            plan3.text,
            impl3.text,
            `Use runTerminalCommand in cwd ${workspacePath}.`,
            `Return EXACTLY this format via markTaskDone:`,
            `STATUS: DONE or BLOCKED`,
            `CHANGED_FILES:`,
            `- <path>`,
            `CHECKS_RUN:`,
            `- <command> => <status>`,
            `SUMMARY:`,
            `<short summary>`,
            `RISKS:`,
            `- <risk>`,
        ].join("\n");

        const integrate = await requestWorker("agent1", integrateInstructions);
        if (!integrate.ok) {
            return [
                `[AUTOCODE_FINAL]`,
                `Status: BLOCKED`,
                `Stage: integration`,
                `Reason: ${integrate.error}`,
                ``,
                `=== AGENT2 RESULT ===`,
                impl2.text,
                ``,
                `=== AGENT3 RESULT ===`,
                impl3.text,
            ].join("\n");
        }

        let repair2: { ok: boolean; text: string; error?: string } | null = null;
        let repair3: { ok: boolean; text: string; error?: string } | null = null;
        let reintegrate: { ok: boolean; text: string; error?: string } | null = null;

        if (parseAutocodeStatus(integrate.text) === "BLOCKED") {
            const repairInstructions = (
                ownedPaths: string[],
                blockedReport: string
            ) => [
                `AUTOCODE MODE (${runId})`,
                `Goal: ${goal}`,
                `Workspace: ${workspacePath}`,
                `This is REPAIR PASS 1 after Agent1 blocked integration.`,
                `Your owned paths:`,
                ...ownedPaths.map((p) => `- ${p}`),
                `Hard rules:`,
                `- You may edit ONLY your owned paths.`,
                `- Fix only issues that fall inside your owned area.`,
                `- Use runTerminalCommand in workspace cwd: ${workspacePath}`,
                `- If the issue is outside your area, keep your files untouched and say so in SUMMARY.`,
                `Blocked integration report from Agent1:`,
                blockedReport,
                `Return EXACTLY this format via markTaskDone:`,
                `STATUS: DONE or BLOCKED`,
                `CHANGED_FILES:`,
                `- <path>`,
                `CHECKS_RUN:`,
                `- <command> => <status>`,
                `SUMMARY:`,
                `<short summary>`,
            ].join("\n");

            repair2 = await requestWorker("agent2", repairInstructions(ownership.agent2, integrate.text));
            repair3 = await requestWorker("agent3", repairInstructions(ownership.agent3, integrate.text));

            if (!repair2.ok || !repair3.ok) {
                return [
                    `[AUTOCODE_FINAL]`,
                    `Status: BLOCKED`,
                    `Stage: repair`,
                    `Workspace: ${relativeWorkspace}`,
                    `Goal: ${goal}`,
                    `Agent2: ${repair2.ok ? "ok" : repair2.error}`,
                    `Agent3: ${repair3.ok ? "ok" : repair3.error}`,
                    ``,
                    `=== OWNERSHIP ===`,
                    `Agent2 writes: ${ownership.agent2.join(", ") || "(none)"}`,
                    `Agent3 writes: ${ownership.agent3.join(", ") || "(none)"}`,
                    ``,
                    `=== AGENT1 INITIAL INTEGRATION ===`,
                    integrate.text,
                    ``,
                    `=== AGENT2 REPAIR RESULT ===`,
                    repair2.text,
                    ``,
                    `=== AGENT3 REPAIR RESULT ===`,
                    repair3.text,
                ].join("\n");
            }

            const reintegrateInstructions = [
                `AUTOCODE MODE (${runId})`,
                `Goal: ${goal}`,
                `Workspace: ${workspacePath}`,
                `You are the integrator. This is REPAIR PASS 1.`,
                `Re-run integration after the worker repair pass, run checks again, and return final status.`,
                `Initial blocked integration report:`,
                integrate.text,
                `Agent2 repair result:`,
                repair2.text,
                `Agent3 repair result:`,
                repair3.text,
                `Use runTerminalCommand in cwd ${workspacePath}.`,
                `Return EXACTLY this format via markTaskDone:`,
                `STATUS: DONE or BLOCKED`,
                `CHANGED_FILES:`,
                `- <path>`,
                `CHECKS_RUN:`,
                `- <command> => <status>`,
                `SUMMARY:`,
                `<short summary>`,
                `RISKS:`,
                `- <risk>`,
            ].join("\n");

            reintegrate = await requestWorker("agent1", reintegrateInstructions);
        }

        const finalIntegration = reintegrate ?? integrate;
        const finalIntegrationStatus = finalIntegration.ok
            ? parseAutocodeStatus(finalIntegration.text)
            : "BLOCKED";
        const agent1Writes = finalIntegration.ok ? parseChangedFiles(finalIntegration.text) : [];

        if (!finalIntegration.ok || finalIntegrationStatus !== "DONE") {
            return [
                `[AUTOCODE_FINAL]`,
                `Status: BLOCKED`,
                `Stage: integration`,
                `Workspace: ${relativeWorkspace}`,
                `Goal: ${goal}`,
                `Reason: ${finalIntegration.ok ? "Agent1 integration remained blocked after repair pass." : finalIntegration.error ?? "Agent1 integration failed."}`,
                ``,
                `=== WRITE MAP ===`,
                `Agent2 writes: ${ownership.agent2.join(", ") || "(none)"}`,
                `Agent3 writes: ${ownership.agent3.join(", ") || "(none)"}`,
                `Agent1 writes: ${agent1Writes.join(", ") || "(none reported)"}`,
                ``,
                `=== AGENT2 RESULT ===`,
                impl2.text,
                ``,
                `=== AGENT3 RESULT ===`,
                impl3.text,
                ``,
                `=== AGENT1 INITIAL INTEGRATION ===`,
                integrate.text,
                ...(repair2 && repair3 ? [
                    ``,
                    `=== AGENT2 REPAIR RESULT ===`,
                    repair2.text,
                    ``,
                    `=== AGENT3 REPAIR RESULT ===`,
                    repair3.text,
                    ``,
                    `=== AGENT1 RE-INTEGRATION ===`,
                    finalIntegration.text,
                ] : []),
            ].join("\n");
        }

        return [
            `[AUTOCODE_FINAL]`,
            `Status: DONE`,
            `Run ID: ${runId}`,
            `Workspace: ${relativeWorkspace}`,
            `Goal: ${goal}`,
            ``,
            `=== OWNERSHIP ===`,
            `Agent2: ${ownership.agent2.join(", ") || "(none)"}`,
            `Agent3: ${ownership.agent3.join(", ") || "(none)"}`,
            ``,
            `=== WRITE MAP ===`,
            `Agent2 writes: ${ownership.agent2.join(", ") || "(none)"}`,
            `Agent3 writes: ${ownership.agent3.join(", ") || "(none)"}`,
            `Agent1 writes: ${agent1Writes.join(", ") || "(none reported)"}`,
            ``,
            `=== AGENT2 PLAN ===`,
            plan2.text,
            ``,
            `=== AGENT3 PLAN ===`,
            plan3.text,
            ``,
            `=== AGENT2 RESULT ===`,
            impl2.text,
            ``,
            `=== AGENT3 RESULT ===`,
            impl3.text,
            ``,
            `=== AGENT1 INITIAL INTEGRATION ===`,
            integrate.text,
            ...(repair2 && repair3 && reintegrate ? [
                ``,
                `=== AGENT2 REPAIR RESULT ===`,
                repair2.text,
                ``,
                `=== AGENT3 REPAIR RESULT ===`,
                repair3.text,
                ``,
                `=== AGENT1 RE-INTEGRATION ===`,
                reintegrate.text,
            ] : []),
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

interface DebateVote {
    agent: "agent1" | "agent3" | "orchestrator";
    pickKey: string;
    pick: string;
    confidence: number;
    updatedInsight: string;
    evidence: string[];
    reason?: string;
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

function stripStaleSeasonLines(text: string): string {
    const lines = text.split("\n");
    const filtered = lines.filter((line) => !/\b(?:2024-25|2023-24|2022-23|2021-22)\b/.test(line));
    return filtered.join("\n");
}

function hasCurrentSeasonSignal(text: string): boolean {
    return /\b2025-26\b|\b2026\b/.test(text);
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

function isPathWithinRoot(candidate: string, root: string): boolean {
    const normalizedRoot = resolve(root);
    const normalizedCandidate = resolve(candidate);
    return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

function parseOwnedPaths(planText: string, workspacePath: string): string[] {
    const lines = planText.split("\n");
    const result: string[] = [];
    let inOwnedPaths = false;

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (/^OWNED_PATHS:/i.test(line)) {
            inOwnedPaths = true;
            continue;
        }
        if (inOwnedPaths && /^[A-Z_]+:/i.test(line) && !line.startsWith("-")) break;
        if (!inOwnedPaths) continue;
        if (!line.startsWith("-")) continue;
        const value = line.replace(/^-+\s*/, "").trim();
        if (!value) continue;
        const resolved = resolve(workspacePath, value);
        if (isPathWithinRoot(resolved, process.cwd())) {
            result.push(resolved);
        }
    }

    return normalizeOwnedPaths(result);
}

function normalizeOwnedPaths(paths: string[]): string[] {
    const unique = Array.from(new Set(paths.map((p) => resolve(p))));
    unique.sort((a, b) => a.length - b.length);

    const normalized: string[] = [];
    for (const candidate of unique) {
        if (normalized.some((existing) => pathsOverlap(existing, candidate))) continue;
        normalized.push(candidate);
    }

    return normalized;
}

function pathsOverlap(a: string, b: string): boolean {
    const ra = resolve(a);
    const rb = resolve(b);
    return ra === rb || ra.startsWith(`${rb}/`) || rb.startsWith(`${ra}/`);
}

function resolveAutocodeOwnership(
    workspacePath: string,
    plan2Text: string,
    plan3Text: string
): { agent2: string[]; agent3: string[] } {
    const proposed2 = normalizeOwnedPaths(parseOwnedPaths(plan2Text, workspacePath));
    const proposed3 = normalizeOwnedPaths(parseOwnedPaths(plan3Text, workspacePath));

    const agent2 = proposed2.length > 0 ? proposed2 : [resolve(workspacePath, "src")];
    const filtered3 = proposed3.filter((p) => !agent2.some((owned) => pathsOverlap(owned, p)));
    const agent3 = filtered3.length > 0
        ? normalizeOwnedPaths(filtered3)
        : normalizeOwnedPaths([resolve(workspacePath, "tests"), resolve(workspacePath, "docs")])
            .filter((p) => !agent2.some((owned) => pathsOverlap(owned, p)));

    return { agent2, agent3 };
}

function parseAutocodeStatus(text: string): "DONE" | "BLOCKED" | "UNKNOWN" {
    const explicit = matchOne(text, /^STATUS:\s*(DONE|BLOCKED)\s*$/im);
    if (explicit === "DONE" || explicit === "BLOCKED") return explicit;
    if (/task blocked|blocked/i.test(text)) return "BLOCKED";
    return "UNKNOWN";
}

function parseChangedFiles(text: string): string[] {
    const lines = text.split("\n");
    const result: string[] = [];
    let inChangedFiles = false;

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (/^CHANGED_FILES:/i.test(line)) {
            inChangedFiles = true;
            continue;
        }
        if (inChangedFiles && /^[A-Z_]+:/i.test(line) && !line.startsWith("-")) break;
        if (!inChangedFiles || !line.startsWith("-")) continue;
        const value = line.replace(/^-+\s*/, "").trim();
        if (value) result.push(value);
    }

    return Array.from(new Set(result));
}

function parseDebateVote(
    agent: "agent1" | "agent3",
    turnText: string,
    teamA: string,
    teamB: string
): DebateVote {
    const rawPick = matchOne(turnText, /FINAL_PICK:\s*(.+)$/im)
        ?? matchOne(turnText, /Position:\s*(.+)$/im)
        ?? "No explicit pick";
    const finalPick = sanitizePickText(rawPick);
    const confidenceRaw = Number.parseInt(matchOne(turnText, /CONFIDENCE:\s*(\d{1,3})/im) ?? "55", 10);
    const confidence = Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(100, confidenceRaw)) : 55;
    const updatedInsight = matchOne(turnText, /UPDATED_INSIGHT:\s*(.+)$/im) ?? "";
    const evidence = Array.from(turnText.matchAll(/EVIDENCE_\d+:\s*(.+)$/gim)).map((m) => m[1].trim()).slice(0, 3);
    const pickKey = normalizePickKey(finalPick, teamA, teamB);

    return {
        agent,
        pickKey,
        pick: finalPick.trim(),
        confidence,
        updatedInsight,
        evidence,
    };
}

function computeOrchestratorVote(v1: DebateVote, v3: DebateVote): DebateVote {
    if (v1.pickKey !== "UNKNOWN" && v1.pickKey === v3.pickKey) {
        return {
            agent: "orchestrator",
            pickKey: v1.pickKey,
            pick: v1.pick,
            confidence: Math.round((v1.confidence + v3.confidence) / 2),
            updatedInsight: "",
            evidence: [],
            reason: "Both agents aligned on same pick.",
        };
    }

    if (v1.pickKey === "UNKNOWN" && v3.pickKey !== "UNKNOWN") {
        return {
            agent: "orchestrator",
            pickKey: v3.pickKey,
            pick: v3.pick,
            confidence: v3.confidence,
            updatedInsight: "",
            evidence: [],
            reason: "Agent1 pick was unparseable; sided with Agent3.",
        };
    }
    if (v3.pickKey === "UNKNOWN" && v1.pickKey !== "UNKNOWN") {
        return {
            agent: "orchestrator",
            pickKey: v1.pickKey,
            pick: v1.pick,
            confidence: v1.confidence,
            updatedInsight: "",
            evidence: [],
            reason: "Agent3 pick was unparseable; sided with Agent1.",
        };
    }

    // Split case: Agent0 tie-break vote by confidence + evidence quality.
    const score = (v: DebateVote) => v.confidence + (v.evidence.length * 4) + (v.updatedInsight ? 3 : 0);
    const s1 = score(v1);
    const s3 = score(v3);

    if (s1 > s3) {
        return {
            agent: "orchestrator",
            pickKey: v1.pickKey,
            pick: v1.pick,
            confidence: v1.confidence,
            updatedInsight: "",
            evidence: [],
            reason: `Tie-break to Agent1 (score ${s1} vs ${s3}).`,
        };
    }
    if (s3 > s1) {
        return {
            agent: "orchestrator",
            pickKey: v3.pickKey,
            pick: v3.pick,
            confidence: v3.confidence,
            updatedInsight: "",
            evidence: [],
            reason: `Tie-break to Agent3 (score ${s3} vs ${s1}).`,
        };
    }

    // Deterministic fallback.
    return {
        agent: "orchestrator",
        pickKey: v1.pickKey,
        pick: v1.pick,
        confidence: v1.confidence,
        updatedInsight: "",
        evidence: [],
        reason: "Tie-break scores equal; defaulted to Agent1 for determinism.",
    };
}

function tallyVotes(v1: DebateVote, v3: DebateVote, o: DebateVote): { counts: Map<string, number>; winnerKey: string } {
    const counts = new Map<string, number>();
    for (const key of [v1.pickKey, v3.pickKey, o.pickKey]) {
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    let winnerKey = "UNKNOWN";
    let winnerCount = 0;
    for (const [key, count] of counts.entries()) {
        if (count > winnerCount) {
            winnerKey = key;
            winnerCount = count;
        } else if (count === winnerCount) {
            winnerKey = "UNKNOWN";
        }
    }

    return { counts, winnerKey };
}

function resolveFinalPick(
    winnerKey: string,
    v1: DebateVote,
    v3: DebateVote,
    o: DebateVote
): string {
    if (winnerKey !== "UNKNOWN") return findFirstPickForKey(winnerKey, v1, v3, o) ?? winnerKey;
    return "NO CONSENSUS (unable to determine a clear majority side).";
}

function findFirstPickForKey(key: string, ...votes: DebateVote[]): string | null {
    for (const vote of votes) {
        if (vote.pickKey === key && vote.pick.trim()) return vote.pick.trim();
    }
    return null;
}

function normalizePickKey(pick: string, teamA: string, teamB: string): string {
    const text = sanitizePickText(pick);
    if (!text || /no explicit pick/i.test(text)) return "UNKNOWN";

    const overUnder = text.match(/\b(over|under)\s+(\d+(?:\.\d+)?)\b/i);
    if (overUnder) return `${overUnder[1].toUpperCase()} ${overUnder[2]}`;

    const ml = text.match(/\b(ml|moneyline)\b/i);
    if (ml) {
        const side = inferTeamSide(text, teamA, teamB);
        if (side !== "UNKNOWN") return `${side} MONEYLINE`;
    }

    const spread = text.match(/([+-]\d+(?:\.\d+)?)/);
    if (spread) {
        const side = inferTeamSide(text, teamA, teamB);
        if (side !== "UNKNOWN") return `${side} ${spread[1]}`;
    }

    const sideOnly = inferTeamSide(text, teamA, teamB);
    if (sideOnly !== "UNKNOWN") return sideOnly;

    return text.toUpperCase();
}

function inferTeamSide(text: string, teamA: string, teamB: string): string {
    const lower = text.toLowerCase();
    const a = teamKeywords(teamA);
    const b = teamKeywords(teamB);
    const hasA = a.some((token) => token && lower.includes(token));
    const hasB = b.some((token) => token && lower.includes(token));

    if (hasA && !hasB) return teamA.toUpperCase();
    if (hasB && !hasA) return teamB.toUpperCase();
    if (hasA && hasB) {
        const idxA = firstKeywordIndex(lower, a);
        const idxB = firstKeywordIndex(lower, b);
        if (idxA >= 0 && idxB >= 0) return idxA <= idxB ? teamA.toUpperCase() : teamB.toUpperCase();
    }
    return "UNKNOWN";
}

function firstKeywordIndex(text: string, keywords: string[]): number {
    let best = -1;
    for (const k of keywords) {
        const idx = text.indexOf(k);
        if (idx >= 0 && (best === -1 || idx < best)) best = idx;
    }
    return best;
}

function teamKeywords(team: string): string[] {
    const normalized = team.toLowerCase().trim();
    const parts = normalized.split(/\s+/).filter(Boolean);
    const last = parts.length > 0 ? parts[parts.length - 1] : normalized;
    return Array.from(new Set([normalized, last])).filter((t) => t.length >= 2);
}

function sanitizePickText(pick: string): string {
    const cleaned = pick
        .replace(/\s+/g, " ")
        .replace(/[—–]/g, "-")
        .replace(/,\s*CONFIDENCE\s*:\s*\d{1,3}\b/i, "")
        .replace(/\s*confidence\s*\d{1,3}\b/i, "")
        .trim();
    return cleaned;
}

function matchOne(text: string, pattern: RegExp): string | null {
    const m = text.match(pattern);
    return m?.[1]?.trim() ?? null;
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
