/**
 * llm.ts — OpenAI-compatible chat completions client.
 *
 * Works with OpenAI, Novita, Groq, or any /v1/chat/completions endpoint.
 * Each agent can use a different model/provider via AgentModelConfig.
 */

import { secrets, type AgentModelConfig } from "./config.js";

export interface ChatMessage {
    role: "system" | "user" | "assistant";
    content: string;
}

export interface ChatOptions {
    model?: string;
    baseUrl?: string;
    maxTokens?: number;
    temperature?: number;
    stop?: string[];
    tools?: Array<{ type: "function"; function: any }>;
}

interface OpenAIResponse {
    choices?: Array<{
        message?: {
            content?: string;
            tool_calls?: Array<{
                id: string;
                type: "function";
                function: { name: string; arguments: string };
            }>;
        };
        finish_reason?: string;
    }>;
    error?: { message?: string };
}

/**
 * Send a chat completion request.
 * If agentConfig is provided, it overrides the defaults with that agent's model/url/tokens.
 */
export async function chatCompletion(
    messages: ChatMessage[],
    agentConfig?: AgentModelConfig,
    options: ChatOptions = {},
): Promise<string> {
    const model = options.model ?? agentConfig?.model ?? "gpt-4o";
    const baseUrl = (options.baseUrl ?? agentConfig?.base_url ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    const maxTokens = options.maxTokens ?? agentConfig?.max_tokens;

    const body: Record<string, unknown> = {
        model,
        messages,
        temperature: options.temperature ?? 0.3,
    };
    if (maxTokens) body.max_tokens = maxTokens;
    if (options.stop?.length) body.stop = options.stop;
    if (options.tools && options.tools.length > 0) body.tools = options.tools;

    const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${secrets.openaiApiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000), // 120s — fail if the LLM provider hangs
    });

    if (!res.ok) {
        const errText = await res.text().catch(() => "unknown");
        throw new Error(`LLM request failed (${res.status}): ${errText}`);
    }

    const data = (await res.json()) as OpenAIResponse;
    if (data.error?.message) throw new Error(`LLM error: ${data.error.message}`);

    const message = data.choices?.[0]?.message;
    if (!message) throw new Error("LLM returned empty response");

    // If the LLM decided to call a tool
    if (message.tool_calls && message.tool_calls.length > 0) {
        // Return a special payload indicating a tool call is requested
        const tc = message.tool_calls[0];
        return JSON.stringify({
            _isToolCall: true,
            name: tc.function?.name,
            arguments: tc.function?.arguments,
        });
    }

    return message.content?.trim() ?? "";
}
