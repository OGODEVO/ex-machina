/**
 * protocol.ts — The Task Protocol
 *
 * Defines the rigid JSON structures agents use to assign
 * tasks, report status, and finish work autonomously.
 */

export type TaskStatus = "assign" | "progress" | "blocked" | "done" | "review" | "chat";

export interface ProtocolMessage {
    type: TaskStatus;
    text: string;           // Human-readable explanation
    assignee?: string;      // Who the task is assigned to (e.g. "agent1")
    metadata?: Record<string, unknown>; // Any extra data (like error logs)
}

/**
 * Helper to check if a payload matches the protocol envelope.
 */
export function isProtocolMessage(payload: unknown): payload is ProtocolMessage {
    if (typeof payload !== "object" || payload === null) return false;
    // If it has a type from our enum, we treat it as a protocol message
    const p = payload as Record<string, unknown>;
    return typeof p.type === "string" && typeof p.text === "string";
}

/**
 * Wrap a standard human message into a generic 'chat' protocol message.
 */
export function createChat(text: string): ProtocolMessage {
    return { type: "chat", text };
}

/**
 * Creates an assignment payload from the Orchestrator to a worker.
 */
export function createAssign(assignee: string, instructions: string): ProtocolMessage {
    return {
        type: "assign",
        assignee,
        text: instructions,
    };
}

/**
 * Creates a completion payload from a worker back to the Orchestrator.
 */
export function createDone(resultText: string, metadata?: Record<string, unknown>): ProtocolMessage {
    return {
        type: "done",
        text: resultText,
        metadata,
    };
}

/**
 * Creates a blocked payload when a worker hits an unrecoverable error.
 */
export function createBlocked(reason: string, errorLog?: string): ProtocolMessage {
    return {
        type: "blocked",
        text: reason,
        metadata: errorLog ? { error: errorLog } : undefined,
    };
}
