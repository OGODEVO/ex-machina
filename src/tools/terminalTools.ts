/**
 * tools/terminalTools.ts — Shell execution with three security modes.
 *
 * STRICT mode:
 *   - Commands run inside a locked sandbox directory (workspace/)
 *   - Only allowlisted binaries can execute
 *   - No shell expansion (pipes, &&, ;, backticks)
 *
 * RELAXED mode:
 *   - Commands can run in any directory under the project root
 *   - All binaries allowed except a denylist (sudo, kill, etc.)
 *   - No shell expansion
 *
 * OPEN mode:
 *   - Full shell access via exec() — pipes, &&, redirections all work
 *   - Can run anywhere on the machine
 *   - Only guardrails: timeout + output cap
 *
 * All modes enforce: 60s timeout, 4000-char output cap.
 */

import { exec, execFile } from "node:child_process";
import { resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import type { ToolSpec } from "./registry.js";
import type { ShellMode } from "../config.js";

const SANDBOX_DIR = resolve(process.cwd(), "workspace");
const PROJECT_ROOT = process.cwd();
const EXEC_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 4_000;

// ── STRICT: only these binaries ──
const ALLOWED_COMMANDS = new Set([
    "node", "npm", "npx", "git", "ls", "cat", "head", "tail",
    "mkdir", "cp", "mv", "touch", "echo", "grep", "find", "wc",
    "curl", "jq", "python3", "python", "tsc", "tsx",
]);

// ── RELAXED: block these binaries ──
const DENIED_COMMANDS = new Set([
    "sudo", "su", "chmod", "chown", "kill", "killall",
    "shutdown", "reboot", "mkfs", "dd", "fdisk",
]);

// ── Both strict/relaxed: block these arg patterns ──
const DANGEROUS_PATTERNS = [
    /--no-preserve-root/i,
    /\/etc\//,
    /\/System\//,
    /\/usr\/bin\//,
    /\/var\//,
    /~\/\.\w+/,
];

function validateCommand(command: string, args: string[], mode: ShellMode): string | null {
    if (mode === "open") return null; // open mode skips all checks

    if (mode === "strict") {
        if (!ALLOWED_COMMANDS.has(command)) {
            return `BLOCKED: "${command}" not in allowlist. Allowed: ${[...ALLOWED_COMMANDS].join(", ")}`;
        }
    } else {
        if (DENIED_COMMANDS.has(command)) {
            return `BLOCKED: "${command}" is on the denylist.`;
        }
    }

    const fullArgs = args.join(" ");
    for (const pattern of DANGEROUS_PATTERNS) {
        if (pattern.test(fullArgs)) {
            return `BLOCKED: Arguments match dangerous pattern ${pattern}.`;
        }
    }

    if (command === "rm" && args.some(a => a.includes("r") && a.startsWith("-"))) {
        return `BLOCKED: Recursive deletion not allowed. Delete files individually.`;
    }

    return null;
}

function resolveWorkingDir(cwd: string | undefined, mode: ShellMode): string {
    if (mode === "strict") {
        if (!existsSync(SANDBOX_DIR)) mkdirSync(SANDBOX_DIR, { recursive: true });
        return SANDBOX_DIR;
    }
    if (mode === "open") {
        return cwd ? resolve(cwd) : process.cwd();
    }
    // relaxed: must be under project root
    if (!cwd) return PROJECT_ROOT;
    const resolved = resolve(cwd);
    if (!resolved.startsWith(PROJECT_ROOT)) return PROJECT_ROOT;
    return resolved;
}

function truncateOutput(output: string): string {
    if (output.length <= MAX_OUTPUT_CHARS) return output;
    return output.substring(0, MAX_OUTPUT_CHARS) + `\n\n... [truncated, ${output.length} total chars]`;
}

/**
 * Creates a shell tool configured for the given security mode.
 * Called from main.ts based on the agent's YAML config.
 */
export function createShellTool(mode: ShellMode): ToolSpec {
    const modeLabel = mode.toUpperCase();

    const descriptionMap: Record<ShellMode, string> = {
        strict: `Execute a terminal command (SANDBOXED). Commands run inside workspace/ only. Allowed binaries: ${[...ALLOWED_COMMANDS].join(", ")}.`,
        relaxed: `Execute a terminal command (RELAXED). Commands can run anywhere in the project. Most binaries allowed except dangerous ones.`,
        open: `Execute any terminal command (OPEN mode). Full shell access with pipes, &&, redirections. Commands can run anywhere.`,
    };

    // Open mode accepts a single command string; strict/relaxed take command + args
    if (mode === "open") {
        return {
            name: "runTerminalCommand",
            description: descriptionMap.open,
            parameters: {
                type: "object",
                properties: {
                    command: {
                        type: "string",
                        description: 'The full shell command to execute (e.g., "npm run build && echo done", "cat file.txt | grep error").',
                    },
                    cwd: {
                        type: "string",
                        description: "Optional working directory. Defaults to project root.",
                    },
                },
                required: ["command"],
            },
            execute: async (args: { command: string; cwd?: string }, _ctx) => {
                const workingDir = resolveWorkingDir(args.cwd, "open");

                return new Promise<string>((resolve) => {
                    exec(
                        args.command,
                        {
                            cwd: workingDir,
                            timeout: EXEC_TIMEOUT_MS,
                            maxBuffer: 1024 * 1024,
                            env: { ...process.env, TERM: "dumb" },
                        },
                        (error, stdout, stderr) => {
                            const parts: string[] = [];
                            if (stdout.trim()) parts.push(`STDOUT:\n${truncateOutput(stdout.trim())}`);
                            if (stderr.trim()) parts.push(`STDERR:\n${truncateOutput(stderr.trim())}`);
                            if (error) {
                                if (error.killed) {
                                    parts.push(`ERROR: Command killed after ${EXEC_TIMEOUT_MS / 1000}s timeout.`);
                                } else {
                                    parts.push(`EXIT CODE: ${error.code ?? "unknown"}`);
                                }
                            }
                            if (parts.length === 0) parts.push("Command completed successfully (no output).");
                            resolve(`[${modeLabel}] $ ${args.command}\nCWD: ${workingDir}\n\n${parts.join("\n\n")}`);
                        }
                    );
                });
            },
        };
    }

    // Strict and relaxed modes: command + args (no shell expansion)
    return {
        name: "runTerminalCommand",
        description: descriptionMap[mode],
        parameters: {
            type: "object",
            properties: {
                command: {
                    type: "string",
                    description: `The binary to execute.${mode === "strict" ? ` Allowed: ${[...ALLOWED_COMMANDS].join(", ")}` : ""}`,
                },
                args: {
                    type: "array",
                    items: { type: "string" },
                    description: 'Arguments to pass. Example: ["install", "--save", "express"]',
                },
                cwd: {
                    type: "string",
                    description: mode === "strict"
                        ? "Ignored. Commands always run in workspace/."
                        : "Optional working directory (must be within the project).",
                },
            },
            required: ["command", "args"],
        },
        execute: async (args: { command: string; args: string[]; cwd?: string }, _ctx) => {
            const blockReason = validateCommand(args.command, args.args, mode);
            if (blockReason) return blockReason;

            const workingDir = resolveWorkingDir(args.cwd, mode);

            return new Promise<string>((resolve) => {
                execFile(
                    args.command,
                    args.args,
                    {
                        cwd: workingDir,
                        timeout: EXEC_TIMEOUT_MS,
                        maxBuffer: 1024 * 1024,
                        env: { ...process.env, TERM: "dumb" },
                    },
                    (error, stdout, stderr) => {
                        const parts: string[] = [];
                        if (stdout.trim()) parts.push(`STDOUT:\n${truncateOutput(stdout.trim())}`);
                        if (stderr.trim()) parts.push(`STDERR:\n${truncateOutput(stderr.trim())}`);
                        if (error) {
                            if (error.killed) {
                                parts.push(`ERROR: Command killed after ${EXEC_TIMEOUT_MS / 1000}s timeout.`);
                            } else {
                                parts.push(`EXIT CODE: ${error.code ?? "unknown"}`);
                            }
                        }
                        if (parts.length === 0) parts.push("Command completed successfully (no output).");
                        resolve(`[${modeLabel}] ${args.command} ${args.args.join(" ")}\nCWD: ${workingDir}\n\n${parts.join("\n\n")}`);
                    }
                );
            });
        },
    };
}
