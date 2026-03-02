#!/usr/bin/env tsx
/**
 * cli.ts — Interactive bash CLI for chatting with AgentNet agents.
 *
 * Usage:  npx tsx src/cli.ts
 *
 * Slash commands:
 *   /agents           — list online agents
 *   /talk <name>      — switch target agent (e.g. /talk orchestrator)
 *   /thread <id>      — switch to a different thread
 *   /thread new       — start a fresh thread
 *   /thread last      — resume last thread for current target
 *   /thread recent    — list recent local threads for current target
 *   /threads          — list threads for your account
 *   /history          — show messages in current thread
 *   /status           — show current thread status / budget
 *   /wait <ms>        — override request timeout for this session
 *   /whoami           — show your CLI agent identity
 *   /clear            — clear the screen
 *   /help             — show command list
 *   /quit             — disconnect and exit
 */

import "dotenv/config";
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { AgentNetClient, type AgentMessage, type AgentInfo } from "agentnet-sdk";

// ── ANSI Colors ──
const C = {
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    dim: "\x1b[2m",
    cyan: "\x1b[36m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    magenta: "\x1b[35m",
    red: "\x1b[31m",
    blue: "\x1b[34m",
    white: "\x1b[37m",
    gray: "\x1b[90m",
    bgCyan: "\x1b[46m",
    bgBlue: "\x1b[44m",
};

const NATS_URL = process.env.NATS_URL ?? "nats://agentnet_secret_token@localhost:4222";
const CLI_AGENT_ID = `cli_user_${randomBytes(4).toString("hex")}`;
const CLI_NAME = "CLI User";
const DEFAULT_REQUEST_TIMEOUT_MS = Number(process.env.CLI_REQUEST_TIMEOUT_MS ?? 600_000); // 10 min default
const CLI_STATE_PATH = process.env.CLI_STATE_PATH ?? resolve(homedir(), ".agentnet-cli-state.json");
const MAX_RECENT_THREADS = 20;
const ENABLE_ANIMATIONS = process.env.CLI_NO_ANIMATIONS !== "1";
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const PANEL_MAX_WIDTH = 110;

interface CliState {
    lastTarget: string;
    lastThreadByTarget: Record<string, string>;
    recentThreadsByTarget: Record<string, string[]>;
    updatedAt: string;
}

function createDefaultCliState(): CliState {
    return {
        lastTarget: "orchestrator_v1",
        lastThreadByTarget: {},
        recentThreadsByTarget: {},
        updatedAt: new Date().toISOString(),
    };
}

function loadCliState(): CliState {
    try {
        const raw = readFileSync(CLI_STATE_PATH, "utf-8");
        const parsed = JSON.parse(raw) as Partial<CliState>;
        return {
            lastTarget: typeof parsed.lastTarget === "string" && parsed.lastTarget.trim()
                ? parsed.lastTarget
                : "orchestrator_v1",
            lastThreadByTarget: parsed.lastThreadByTarget && typeof parsed.lastThreadByTarget === "object"
                ? parsed.lastThreadByTarget
                : {},
            recentThreadsByTarget: parsed.recentThreadsByTarget && typeof parsed.recentThreadsByTarget === "object"
                ? parsed.recentThreadsByTarget
                : {},
            updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
        };
    } catch {
        return createDefaultCliState();
    }
}

function saveCliState(state: CliState): void {
    try {
        state.updatedAt = new Date().toISOString();
        writeFileSync(CLI_STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
    } catch {
        // Best-effort only; do not break CLI if local state cannot be saved.
    }
}

// ── State ──
const cliState = loadCliState();
let currentTarget = cliState.lastTarget || "orchestrator_v1"; // username of the agent to talk to
let currentThread = cliState.lastThreadByTarget[currentTarget] || `cli_${Date.now().toString(36)}`;
let client: AgentNetClient;
let inFlightRequest = false;
let requestTimeoutMs = Number.isFinite(DEFAULT_REQUEST_TIMEOUT_MS) && DEFAULT_REQUEST_TIMEOUT_MS >= 10_000
    ? DEFAULT_REQUEST_TIMEOUT_MS
    : 600_000;

function getRecentThreads(target: string): string[] {
    return cliState.recentThreadsByTarget[target] ?? [];
}

function rememberThread(target: string, threadId: string): void {
    const id = threadId.trim();
    if (!id) return;
    const existing = getRecentThreads(target);
    const next = [id, ...existing.filter((x) => x !== id)].slice(0, MAX_RECENT_THREADS);
    cliState.recentThreadsByTarget[target] = next;
    cliState.lastThreadByTarget[target] = id;
    cliState.lastTarget = target;
    saveCliState(cliState);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripAnsi(value: string): string {
    return value.replace(/\x1B\[[0-9;]*m/g, "");
}

function fitLine(line: string, width: number): string {
    const raw = stripAnsi(line);
    if (raw.length <= width) return line + " ".repeat(width - raw.length);
    return raw.slice(0, Math.max(0, width - 1)) + "…";
}

function renderPanel(title: string, body: string, color: string = C.cyan): string {
    const lines = body.split("\n");
    const contentWidth = Math.min(
        PANEL_MAX_WIDTH,
        Math.max(
            stripAnsi(title).length + 2,
            ...lines.map((l) => stripAnsi(l).length)
        )
    );

    const top = `${color}╭${"─".repeat(contentWidth + 2)}╮${C.reset}`;
    const titleLine = `${color}│${C.reset} ${C.bold}${fitLine(title, contentWidth)}${C.reset} ${color}│${C.reset}`;
    const divider = `${color}├${"─".repeat(contentWidth + 2)}┤${C.reset}`;
    const content = lines.map((line) => `${color}│${C.reset} ${fitLine(line, contentWidth)} ${color}│${C.reset}`).join("\n");
    const bottom = `${color}╰${"─".repeat(contentWidth + 2)}╯${C.reset}`;

    return [top, titleLine, divider, content, bottom].join("\n");
}

function startSpinner(label: string): { stop: () => void } {
    if (!ENABLE_ANIMATIONS) {
        process.stdout.write(`  ${C.dim}⏳ ${label}${C.reset}`);
        return {
            stop: () => {
                process.stdout.write("\r\x1b[K");
            },
        };
    }

    let frame = 0;
    process.stdout.write(`  ${C.dim}${SPINNER_FRAMES[frame]} ${label}${C.reset}`);
    const timer = setInterval(() => {
        frame = (frame + 1) % SPINNER_FRAMES.length;
        process.stdout.write(`\r\x1b[K  ${C.dim}${SPINNER_FRAMES[frame]} ${label}${C.reset}`);
    }, 80);

    return {
        stop: () => {
            clearInterval(timer);
            process.stdout.write("\r\x1b[K");
        },
    };
}

function centerLine(text: string): string {
    const width = process.stdout.columns || 100;
    const raw = stripAnsi(text);
    const pad = Math.max(0, Math.floor((width - raw.length) / 2));
    return `${" ".repeat(pad)}${text}`;
}

function printCenteredIdentity(agents: AgentInfo[]): void {
    const onlineNames = agents.map((a: any) => `@${a.username || a.agent_id}`).join("  ");
    const lines = [
        `${C.bold}${C.cyan}WHO'S WHO${C.reset}`,
        `${C.green}${C.bold}U${C.reset} = You (${CLI_AGENT_ID})`,
        `${C.magenta}${C.bold}A${C.reset} = Active Agent (${currentTarget})`,
        `${C.dim}Online:${C.reset} ${onlineNames || "none"}`,
    ];
    console.log();
    for (const line of lines) console.log(centerLine(line));
    console.log();
}

async function introPulse(): Promise<void> {
    if (!ENABLE_ANIMATIONS) return;
    const pulse = ["·", "•", "◦", "•"];
    for (let i = 0; i < 10; i++) {
        const dot = pulse[i % pulse.length];
        process.stdout.write(`\r${C.dim}${dot} Booting AgentNet CLI ${dot}${C.reset}`);
        await sleep(55);
    }
    process.stdout.write("\r\x1b[K");
}

// ── Helpers ──
function banner() {
    console.log(`
${C.cyan}${C.bold}╔══════════════════════════════════════════════════════╗
║${C.white}   █████╗  ██████╗ ███████╗███╗   ██╗████████╗███╗   ██╗   ${C.cyan}║
║${C.white}  ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝████╗  ██║   ${C.cyan}║
║${C.white}  ███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║   ██╔██╗ ██║   ${C.cyan}║
║${C.white}  ██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║   ██║╚██╗██║   ${C.cyan}║
║${C.white}  ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║   ██║ ╚████║   ${C.cyan}║
║${C.white}  ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝   ╚═╝  ╚═══╝   ${C.cyan}║
║${C.white}                     CLI COMMAND CENTER                     ${C.cyan}║
╚══════════════════════════════════════════════════════╝${C.reset}
${C.dim}  Type a message to chat, or /help for commands. /thread last to resume.${C.reset}
`);
}

function printHelp() {
    console.log(`
${C.yellow}${C.bold}Commands:${C.reset}
  ${C.green}/agents${C.reset}           List online agents
  ${C.green}/talk <name>${C.reset}      Switch target agent  ${C.dim}(e.g. /talk agent1)${C.reset}
  ${C.green}/thread <id>${C.reset}      Switch to thread ID
  ${C.green}/thread new${C.reset}       Start a fresh thread
  ${C.green}/thread last${C.reset}      Resume last thread for current target
  ${C.green}/thread recent${C.reset}    List recent local threads for current target
  ${C.green}/threads${C.reset}          List your threads
  ${C.green}/history${C.reset}          Show messages in current thread
  ${C.green}/status${C.reset}           Current thread budget/status
  ${C.green}/wait <ms>${C.reset}        Set request timeout for this session
  ${C.green}/whoami${C.reset}           Show your CLI identity
  ${C.green}/clear${C.reset}            Clear the screen
  ${C.green}/help${C.reset}             Show this help
  ${C.green}/quit${C.reset}             Exit
`);
}

function promptText(): string {
    return `${C.blue}[${currentTarget}${C.dim}#${currentThread.slice(0, 12)}${C.blue}]${C.reset} ${C.bold}>${C.reset} `;
}

function extractText(payload: unknown): string {
    if (typeof payload === "string") return payload;
    if (typeof payload === "object" && payload !== null) {
        const p = payload as Record<string, unknown>;
        if (typeof p.text === "string") return p.text;
        return JSON.stringify(payload, null, 2);
    }
    return String(payload);
}

function printAgent(info: AgentInfo, idx: number) {
    const name = (info as any).name || info.agent_id;
    const username = (info as any).username || info.agent_id;
    const online = `${C.green}●${C.reset}`;
    const active = username === currentTarget ? ` ${C.cyan}◀ talking${C.reset}` : "";
    console.log(`  ${online} ${C.bold}${name}${C.reset} ${C.dim}(@${username})${C.reset}  ${C.gray}[${info.agent_id}]${C.reset}${active}`);
}

// ── Slash Command Handlers ──

async function cmdAgents() {
    try {
        const agents = await client.listOnlineAgents();
        if (agents.length === 0) {
            console.log(`  ${C.yellow}No agents online.${C.reset}`);
            return;
        }
        console.log(`\n${C.cyan}${C.bold}  Online Agents (${agents.length}):${C.reset}`);
        agents.forEach((a, i) => printAgent(a, i));
        console.log();
    } catch (e: any) {
        console.log(`  ${C.red}Error listing agents: ${e.message}${C.reset}`);
    }
}

async function cmdTalk(name: string) {
    if (!name) {
        console.log(`  ${C.yellow}Usage: /talk <agent_username>${C.reset}`);
        return;
    }
    currentTarget = name.trim();
    const resumed = cliState.lastThreadByTarget[currentTarget];
    if (resumed) {
        currentThread = resumed;
        rememberThread(currentTarget, currentThread);
        console.log(`  ${C.green}Now talking to ${C.bold}@${currentTarget}${C.reset} ${C.dim}(resumed thread ${currentThread})${C.reset}`);
        return;
    }
    rememberThread(currentTarget, currentThread);
    console.log(`  ${C.green}Now talking to ${C.bold}@${currentTarget}${C.reset}`);
}

async function cmdThread(arg: string) {
    if (!arg) {
        console.log(`  ${C.yellow}Current thread: ${C.bold}${currentThread}${C.reset}`);
        return;
    }
    if (arg === "new") {
        currentThread = `cli_${Date.now().toString(36)}`;
        rememberThread(currentTarget, currentThread);
        console.log(`  ${C.green}New thread: ${C.bold}${currentThread}${C.reset}`);
    } else if (arg === "last") {
        const last = cliState.lastThreadByTarget[currentTarget];
        if (!last) {
            console.log(`  ${C.yellow}No saved last thread for @${currentTarget}.${C.reset}`);
            return;
        }
        currentThread = last;
        rememberThread(currentTarget, currentThread);
        console.log(`  ${C.green}Resumed last thread: ${C.bold}${currentThread}${C.reset}`);
    } else if (arg === "recent") {
        const recent = getRecentThreads(currentTarget);
        if (recent.length === 0) {
            console.log(`  ${C.yellow}No recent local threads for @${currentTarget}.${C.reset}`);
            return;
        }
        console.log(`\n${C.cyan}${C.bold}  Recent Threads (@${currentTarget})${C.reset}`);
        recent.forEach((tid, idx) => {
            const marker = tid === currentThread ? ` ${C.green}◀ current${C.reset}` : "";
            console.log(`  ${C.dim}${idx + 1}.${C.reset} ${C.bold}${tid}${C.reset}${marker}`);
        });
        console.log(`  ${C.dim}Use /thread <id> or /thread last${C.reset}\n`);
    } else {
        currentThread = arg.trim();
        rememberThread(currentTarget, currentThread);
        console.log(`  ${C.green}Switched to thread: ${C.bold}${currentThread}${C.reset}`);
    }
}

async function cmdThreads() {
    try {
        const threads = await client.listThreads({ limit: 20 });
        if (threads.length === 0) {
            console.log(`  ${C.yellow}No threads found.${C.reset}`);
            return;
        }
        console.log(`\n${C.cyan}${C.bold}  Threads:${C.reset}`);
        for (const t of threads) {
            const tid = (t as any).thread_id ?? (t as any).id ?? "?";
            const msgCount = (t as any).message_count ?? "";
            const marker = tid === currentThread ? ` ${C.green}◀ current${C.reset}` : "";
            console.log(`  ${C.dim}•${C.reset} ${C.bold}${tid}${C.reset} ${C.gray}(${msgCount} msgs)${C.reset}${marker}`);
        }
        console.log();
    } catch (e: any) {
        console.log(`  ${C.red}Error listing threads: ${e.message}${C.reset}`);
    }
}

async function cmdHistory() {
    try {
        const result = await client.getThreadMessages(currentThread, { limit: 30 });
        const messages = (result as any).messages;
        if (!Array.isArray(messages) || messages.length === 0) {
            console.log(`  ${C.yellow}No messages in thread ${currentThread}.${C.reset}`);
            return;
        }
        console.log(`\n${C.cyan}${C.bold}  Thread: ${currentThread}${C.reset}`);
        console.log(`${C.dim}  ${"─".repeat(50)}${C.reset}`);
        for (const msg of messages) {
            const from = msg.from_agent ?? msg.from_username ?? "unknown";
            const text = extractText(msg.payload);
            const time = msg.sent_at ? new Date(msg.sent_at).toLocaleTimeString() : "";
            console.log(`  ${C.magenta}${from}${C.reset} ${C.dim}${time}${C.reset}`);
            console.log(`  ${text}`);
            console.log(`${C.dim}  ${"─".repeat(50)}${C.reset}`);
        }
        console.log();
    } catch (e: any) {
        console.log(`  ${C.red}Error loading history: ${e.message}${C.reset}`);
    }
}

async function cmdStatus() {
    try {
        const status = await client.threadStatus(currentThread);
        console.log(`\n${C.cyan}${C.bold}  Thread Status: ${currentThread}${C.reset}`);
        for (const [k, v] of Object.entries(status)) {
            console.log(`  ${C.dim}${k}:${C.reset} ${JSON.stringify(v)}`);
        }
        console.log();
    } catch (e: any) {
        console.log(`  ${C.red}Error: ${e.message}${C.reset}`);
    }
}

function cmdWait(arg: string) {
    const ms = Number(arg);
    if (!Number.isFinite(ms) || ms < 10_000) {
        console.log(`  ${C.yellow}Usage: /wait <milliseconds> (minimum 10000)${C.reset}`);
        console.log(`  ${C.dim}Current timeout: ${requestTimeoutMs}ms${C.reset}`);
        return;
    }
    requestTimeoutMs = Math.floor(ms);
    console.log(`  ${C.green}Request timeout set to ${requestTimeoutMs}ms${C.reset}`);
}

function cmdWhoami() {
    console.log(`
  ${C.cyan}Agent ID:${C.reset}  ${CLI_AGENT_ID}
  ${C.cyan}Name:${C.reset}      ${CLI_NAME}
  ${C.cyan}Account:${C.reset}   ${client.getAccountId() ?? "not registered"}
  ${C.cyan}Target:${C.reset}    @${currentTarget}
  ${C.cyan}Thread:${C.reset}    ${currentThread}
  ${C.cyan}State:${C.reset}     ${CLI_STATE_PATH}
  ${C.cyan}Timeout:${C.reset}   ${requestTimeoutMs}ms
  ${C.cyan}NATS:${C.reset}      ${NATS_URL.replace(/\/\/.*@/, "//***@")}
`);
}

// ── Chat ──

async function sendChat(text: string) {
    const payload = { type: "chat", text };
    rememberThread(currentTarget, currentThread);
    console.log(renderPanel(`U (${CLI_AGENT_ID})`, text, C.green));
    console.log();
    const spinner = startSpinner(`Waiting for @${currentTarget} (timeout ${requestTimeoutMs}ms)`);

    try {
        const reply: AgentMessage = await client.request(
            `@${currentTarget}`,
            payload,
            { threadId: currentThread, timeoutMs: requestTimeoutMs }
        );

        spinner.stop();

        const responseText = extractText(reply.payload);
        console.log(renderPanel(`@${currentTarget}`, responseText, C.magenta));
        console.log();
    } catch (e: any) {
        spinner.stop();
        const message = String(e?.message ?? e ?? "Unknown error");
        if (message.toUpperCase().includes("TIMEOUT")) {
            const timeoutBody = [
                "Request timed out waiting for direct reply.",
                "Backend may still complete this task.",
                "Run /history in this thread to fetch late results."
            ].join("\n");
            console.log(renderPanel("TIMEOUT", timeoutBody, C.yellow));
        } else {
            console.log(renderPanel("ERROR", message, C.red));
        }
        console.log();
    }
}

// ── Main ──

async function main() {
    await introPulse();
    banner();

    // Connect to NATS as a CLI agent
    client = new AgentNetClient({
        natsUrl: NATS_URL,
        agentId: CLI_AGENT_ID,
        name: CLI_NAME,
        username: CLI_AGENT_ID,
        capabilities: ["chat"],
        metadata: { type: "cli" },
    });

    try {
        await client.start();
        rememberThread(currentTarget, currentThread);
        const online = await client.listOnlineAgents().catch(() => [] as AgentInfo[]);
        printCenteredIdentity(online);
        console.log(`  ${C.green}✓ Connected to AgentNet${C.reset} ${C.dim}(${client.getAccountId()})${C.reset}`);
        console.log(`  ${C.dim}Talking to: @${currentTarget} | Thread: ${currentThread}${C.reset}\n`);
    } catch (e: any) {
        console.error(`${C.red}Failed to connect: ${e.message}${C.reset}`);
        process.exit(1);
    }

    // Set up readline
    const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: promptText(),
        terminal: true,
    });

    rl.prompt();

    rl.on("line", async (line: string) => {
        const input = line.trim();
        if (!input) {
            rl.setPrompt(promptText());
            rl.prompt();
            return;
        }

        if (inFlightRequest) {
            console.log(`  ${C.yellow}Still waiting for the previous request. Please wait.${C.reset}`);
            rl.setPrompt(promptText());
            rl.prompt();
            return;
        }

        inFlightRequest = true;

        // Slash commands
        try {
            if (input.startsWith("/")) {
                const [cmd, ...rest] = input.split(/\s+/);
                const arg = rest.join(" ");

                switch (cmd.toLowerCase()) {
                    case "/agents":
                        await cmdAgents();
                        break;
                    case "/talk":
                        await cmdTalk(arg);
                        break;
                    case "/thread":
                        await cmdThread(arg);
                        break;
                    case "/threads":
                        await cmdThreads();
                        break;
                    case "/history":
                        await cmdHistory();
                        break;
                    case "/status":
                        await cmdStatus();
                        break;
                    case "/wait":
                        cmdWait(arg);
                        break;
                    case "/whoami":
                        cmdWhoami();
                        break;
                    case "/clear":
                        console.clear();
                        banner();
                        break;
                    case "/help":
                        printHelp();
                        break;
                    case "/quit":
                    case "/exit":
                        console.log(`\n  ${C.yellow}Disconnecting...${C.reset}`);
                        await client.close();
                        console.log(`  ${C.green}Goodbye! 👋${C.reset}\n`);
                        process.exit(0);
                    default:
                        console.log(`  ${C.yellow}Unknown command: ${cmd}. Type /help${C.reset}`);
                }
            } else {
                // Regular message → send to agent
                await sendChat(input);
            }
        } finally {
            inFlightRequest = false;
        }

        rl.setPrompt(promptText());
        rl.prompt();
    });

    rl.on("close", async () => {
        console.log(`\n  ${C.yellow}Disconnecting...${C.reset}`);
        await client.close();
        process.exit(0);
    });
}

main().catch((err) => {
    console.error(`${C.red}Fatal: ${err.message}${C.reset}`);
    process.exit(1);
});
