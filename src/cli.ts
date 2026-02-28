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
 *   /threads          — list threads for your account
 *   /history          — show messages in current thread
 *   /status           — show current thread status / budget
 *   /whoami           — show your CLI agent identity
 *   /clear            — clear the screen
 *   /help             — show command list
 *   /quit             — disconnect and exit
 */

import "dotenv/config";
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
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

const NATS_URL = process.env.NATS_URL ?? "nats://localhost:4222";
const CLI_AGENT_ID = `cli_user_${randomBytes(4).toString("hex")}`;
const CLI_NAME = "CLI User";
const REQUEST_TIMEOUT_MS = 120_000; // 2 min for LLM responses

// ── State ──
let currentTarget = "orchestrator_v1"; // username of the agent to talk to
let currentThread = `cli_${Date.now().toString(36)}`;
let client: AgentNetClient;

// ── Helpers ──
function banner() {
    console.log(`
${C.cyan}${C.bold}╔══════════════════════════════════════════════════════╗
║              ${C.white}⚡  AgentNet CLI  ⚡${C.cyan}                     ║
╚══════════════════════════════════════════════════════╝${C.reset}
${C.dim}  Type a message to chat, or /help for commands.${C.reset}
`);
}

function printHelp() {
    console.log(`
${C.yellow}${C.bold}Commands:${C.reset}
  ${C.green}/agents${C.reset}           List online agents
  ${C.green}/talk <name>${C.reset}      Switch target agent  ${C.dim}(e.g. /talk agent1)${C.reset}
  ${C.green}/thread <id>${C.reset}      Switch to thread ID
  ${C.green}/thread new${C.reset}       Start a fresh thread
  ${C.green}/threads${C.reset}          List your threads
  ${C.green}/history${C.reset}          Show messages in current thread
  ${C.green}/status${C.reset}           Current thread budget/status
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
    console.log(`  ${C.green}Now talking to ${C.bold}@${currentTarget}${C.reset}`);
}

async function cmdThread(arg: string) {
    if (!arg) {
        console.log(`  ${C.yellow}Current thread: ${C.bold}${currentThread}${C.reset}`);
        return;
    }
    if (arg === "new") {
        currentThread = `cli_${Date.now().toString(36)}`;
        console.log(`  ${C.green}New thread: ${C.bold}${currentThread}${C.reset}`);
    } else {
        currentThread = arg.trim();
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

function cmdWhoami() {
    console.log(`
  ${C.cyan}Agent ID:${C.reset}  ${CLI_AGENT_ID}
  ${C.cyan}Name:${C.reset}      ${CLI_NAME}
  ${C.cyan}Account:${C.reset}   ${client.getAccountId() ?? "not registered"}
  ${C.cyan}Target:${C.reset}    @${currentTarget}
  ${C.cyan}Thread:${C.reset}    ${currentThread}
  ${C.cyan}NATS:${C.reset}      ${NATS_URL.replace(/\/\/.*@/, "//***@")}
`);
}

// ── Chat ──

async function sendChat(text: string) {
    const payload = { type: "chat", text };
    process.stdout.write(`  ${C.dim}⏳ Waiting for @${currentTarget}...${C.reset}`);

    try {
        const reply: AgentMessage = await client.request(
            `@${currentTarget}`,
            payload,
            { threadId: currentThread, timeoutMs: REQUEST_TIMEOUT_MS }
        );

        // Clear the waiting line
        process.stdout.write("\r\x1b[K");

        const responseText = extractText(reply.payload);
        console.log(`  ${C.magenta}${C.bold}@${currentTarget}${C.reset}: ${responseText}`);
        console.log();
    } catch (e: any) {
        process.stdout.write("\r\x1b[K");
        console.log(`  ${C.red}Error: ${e.message}${C.reset}`);
        console.log();
    }
}

// ── Main ──

async function main() {
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

        // Slash commands
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
