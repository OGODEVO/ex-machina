/**
 * tools/registry.ts — The Tool Execution Framework
 *
 * Defines how tools are structured and how the LLM calls them.
 */

export interface ToolSpec {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema defining the arguments
    execute: (args: any, context: ToolContext) => Promise<string>;
}

export interface ToolContext {
    agentId: string;
    // We can pass the NetworkBridge in here later if tools need to send messages
    reply?: (payload: unknown) => Promise<string>;
    [key: string]: any;
}

export class ToolRegistry {
    private tools = new Map<string, ToolSpec>();

    /** Register a new tool. */
    register(tool: ToolSpec) {
        this.tools.set(tool.name, tool);
    }

    /** Get the JSON definitions to pass to the LLM (OpenAI format). */
    getOpenAITools(): Array<{ type: "function"; function: Omit<ToolSpec, "execute"> }> {
        return Array.from(this.tools.values()).map((t) => ({
            type: "function",
            function: {
                name: t.name,
                description: t.description,
                parameters: t.parameters,
            },
        }));
    }

    /** Execute a tool by name with arguments parsed from the LLM. */
    async executeTool(name: string, argsRaw: string, context: ToolContext): Promise<string> {
        const tool = this.tools.get(name);
        if (!tool) {
            return `Error: Tool '${name}' not found.`;
        }

        try {
            const args = JSON.parse(argsRaw);
            return await tool.execute(args, context);
        } catch (err: any) {
            return `Error executing '${name}': ${err.message}`;
        }
    }

    /** Returns true if there are any tools registered. */
    hasTools(): boolean {
        return this.tools.size > 0;
    }
}
