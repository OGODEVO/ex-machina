import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent } from "./agent.js";
import { secrets, getAgentShellMode } from "./config.js";
import { assignTasksTool, answerDirectlyTool, facilitateDebateTool } from "./tools/orchestratorTools.js";
import { markTaskDoneTool, askQuestionTool, reportErrorTool } from "./tools/workerTools.js";
import { chatWithAgentTool, discoverAgentsTool, endConversationTool } from "./tools/sharedTools.js";
import { searchWebTool, deepSearchTool } from "./tools/searchTools.js";
import { createShellTool } from "./tools/terminalTools.js";
import { scrapePageTool, browserActionTool, closeBrowser } from "./tools/browserTools.js";
import { getDailyScheduleTool, preGameAnalysisTool, liveGameAnalysisTool } from "./tools/nbaTools.js";
import type { ToolSpec } from "./tools/registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const promptsDir = resolve(__dirname, "..", "prompts");

function loadPrompt(filename: string): string {
    const base = readFileSync(resolve(promptsDir, filename), "utf-8").trim();
    // Inject current date/time context so agents aren't confused
    const currentDate = new Date().toLocaleString("en-US", { timeZone: "America/Chicago", timeZoneName: "short" });
    return `${base}\n\n# SYSTEM CONTEXT\nCurrent Date & Time: ${currentDate}\nUser Location: Texas, USA\n`;
}

/** Build the tools array for a worker agent, adding shell if configured in YAML. */
function buildWorkerTools(agentId: string): ToolSpec[] {
    const base = [markTaskDoneTool, askQuestionTool, reportErrorTool, chatWithAgentTool, discoverAgentsTool, endConversationTool, searchWebTool, deepSearchTool];

    const shellMode = getAgentShellMode(agentId);
    if (shellMode) {
        console.log(`[config] ${agentId} → shell_mode: ${shellMode}`);
        base.push(createShellTool(shellMode));
    }

    return base;
}

async function main() {
    console.log("Starting Agent OS...");

    const agentProfiles = `
# AVAILABLE AGENTS
- **Agent 1** (ID: agent1): Capabilities: [terminal-execution, bash, python, coding]. If the user asks to run a command, install software, or execute code, you MUST use assignTasks to send it to Agent 1. Do NOT use chatWithAgent for execution tasks.
- **Agent 2** (ID: agent2): Capabilities: [research, analysis, nba-data]
- **Agent 3** (ID: agent3): Capabilities: [review, critique, browser]
`;

    const orchestrator = new Agent({
        id: secrets.orchestratorId,
        name: secrets.orchestratorName,
        systemPrompt: loadPrompt("orchestrator.txt") + `\n\n${agentProfiles}`,
        capabilities: ["orchestration", "search"],
        tools: [assignTasksTool, answerDirectlyTool, facilitateDebateTool, chatWithAgentTool, discoverAgentsTool, endConversationTool, searchWebTool, deepSearchTool],
    });

    // 2. Agent 1
    const agent1 = new Agent({
        id: "agent1",
        name: "Agent 1",
        systemPrompt: loadPrompt("agent1.txt"),
        capabilities: ["execution", "coding"],
        tools: buildWorkerTools("agent1"),
    });

    // 3. Agent 2 — Research + NBA Data
    const agent2 = new Agent({
        id: "agent2",
        name: "Agent 2",
        systemPrompt: loadPrompt("agent2.txt"),
        capabilities: ["research", "analysis", "nba-data"],
        tools: [...buildWorkerTools("agent2"), getDailyScheduleTool, preGameAnalysisTool, liveGameAnalysisTool],
    });

    // 4. Agent 3
    const agent3 = new Agent({
        id: "agent3",
        name: "Agent 3",
        systemPrompt: loadPrompt("agent3.txt"),
        capabilities: ["review", "critique", "browser"],
        tools: [...buildWorkerTools("agent3"), scrapePageTool, browserActionTool],
    });

    // Start all agents concurrently
    await Promise.all([
        orchestrator.start(),
        agent1.start(),
        agent2.start(),
        agent3.start(),
    ]);

    console.log("\n✅ All 4 agents are online and connected to AgentNet.");

    // Handle graceful shutdown
    process.on("SIGINT", async () => {
        console.log("\nShutting down Agent OS...");
        await Promise.all([
            orchestrator.stop(),
            agent1.stop(),
            agent2.stop(),
            agent3.stop(),
            closeBrowser(),
        ]);
        process.exit(0);
    });
}

main().catch((err) => {
    console.error("Fatal startup error:", err);
    process.exit(1);
});
