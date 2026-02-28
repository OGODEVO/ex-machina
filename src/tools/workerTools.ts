/**
 * tools/workerTools.ts — Specialized tools for Agents 1, 2, and 3.
 *
 * These tools allow workers to:
 * 1. Mark a task as complete
 * 2. Ask the Orchestrator a clarifying question
 * 3. Report an actual error they cannot recover from
 */

import type { ToolSpec } from "./registry.js";
import { createDone, createBlocked, createChat } from "../protocol.js";
import { secrets } from "../config.js";

/**
 * Tool: markTaskDone
 * Used when a worker has fully completed its assigned task.
 */
export const markTaskDoneTool: ToolSpec = {
    name: "markTaskDone",
    description: "Use this ONLY when you have fully completed the task assigned to you by Orchestrator. Provide a detailed summary of your results.",
    parameters: {
        type: "object",
        properties: {
            resultSummary: {
                type: "string",
                description: "Everything Orchestrator needs to know about the completed task (code, links, findings, etc).",
            },
        },
        required: ["resultSummary"],
    },
    execute: async (args: { resultSummary: string }, ctx) => {
        if (!ctx.bridge || !ctx.threadId) {
            throw new Error("Missing network context to send status message.");
        }

        const payload = createDone(args.resultSummary);
        await ctx.bridge.sendMessage(secrets.orchestratorId, ctx.threadId, payload);

        return `Successfully sent [PROTOCOL: DONE] to Orchestrator. Wait for further instructions.`;
    },
};

/**
 * Tool: askQuestion
 * Used when a worker needs clarification from the Orchestrator before continuing.
 */
export const askQuestionTool: ToolSpec = {
    name: "askQuestion",
    description: "Use this when you need clarification or more context from the Orchestrator before you can proceed. This does NOT mark your task as failed — it just asks a question.",
    parameters: {
        type: "object",
        properties: {
            question: {
                type: "string",
                description: "The specific question you need answered to continue your work.",
            },
        },
        required: ["question"],
    },
    execute: async (args: { question: string }, ctx) => {
        if (!ctx.bridge || !ctx.threadId) {
            throw new Error("Missing network context to send question.");
        }

        const payload = createChat(args.question);
        await ctx.bridge.sendMessage(secrets.orchestratorId, ctx.threadId, payload);

        return `Question sent to Orchestrator. Wait for their reply before continuing.`;
    },
};

/**
 * Tool: reportError
 * Used when a worker hits an actual unrecoverable error (crash, missing API key, etc).
 */
export const reportErrorTool: ToolSpec = {
    name: "reportError",
    description: "Use this ONLY when you encounter an actual error you cannot recover from (e.g., a command crashed, an API returned a fatal error, a file is missing). Do NOT use this for questions.",
    parameters: {
        type: "object",
        properties: {
            reason: {
                type: "string",
                description: "Explain what went wrong.",
            },
            errorLog: {
                type: "string",
                description: "The raw error output from the terminal or API (if available).",
            },
        },
        required: ["reason"],
    },
    execute: async (args: { reason: string; errorLog?: string }, ctx) => {
        if (!ctx.bridge || !ctx.threadId) {
            throw new Error("Missing network context to report error.");
        }

        const payload = createBlocked(args.reason, args.errorLog);
        await ctx.bridge.sendMessage(secrets.orchestratorId, ctx.threadId, payload);

        return `Error reported to Orchestrator. Wait for further instructions.`;
    },
};
