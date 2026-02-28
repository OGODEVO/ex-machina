/**
 * llm.ts — OpenAI-compatible chat completions client.
 *
 * Works with OpenAI, Novita, Groq, or any /v1/chat/completions endpoint.
 * Each agent can use a different model/provider via AgentModelConfig.
 *
 * Resilience: retry with exponential backoff + circuit breaker.
 */

import { secrets, type AgentModelConfig } from "./config.js";
import { withRetry, CircuitBreaker, isRetryableHttpStatus, isRetryableError } from "./resilience.js";

// One circuit breaker per LLM base URL
const breakers = new Map<string, CircuitBreaker>();

function getBreaker(baseUrl: string): CircuitBreaker {
    if (!breakers.has(baseUrl)) {
        breakers.set(baseUrl, new CircuitBreaker(`llm:${baseUrl}`, {
            failureThreshold: 5,
            cooldownMs: 30_000,
        }));
    }
    return breakers.get(baseUrl)!;
}

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
 * Send a chat completion request with retry + circuit breaker.
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

    const breaker = getBreaker(baseUrl);

    return breaker.call(() =>
        withRetry(
            async () => {
                const res = await fetch(`${baseUrl}/chat/completions`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${secrets.openaiApiKey}`,
                    },
                    body: JSON.stringify(body),
                    signal: AbortSignal.timeout(120_000),
                });

                if (!res.ok) {
                    const errText = await res.text().catch(() => "unknown");
                    const err = new Error(`LLM request failed (${res.status}): ${errText}`);
                    // Tag retryable status so withRetry knows to retry
                    (err as any).httpStatus = res.status;
                    throw err;
                }

                const data = (await res.json()) as OpenAIResponse;
                if (data.error?.message) throw new Error(`LLM error: ${data.error.message}`);

                const message = data.choices?.[0]?.message;
                if (!message) throw new Error("LLM returned empty response");

                // If the LLM decided to call a tool
                if (message.tool_calls && message.tool_calls.length > 0) {
                    const tc = message.tool_calls[0];
                    return JSON.stringify({
                        _isToolCall: true,
                        name: tc.function?.name,
                        arguments: tc.function?.arguments,
                    });
                }

                return message.content?.trim() ?? "";
            },
            {
                maxRetries: 3,
                baseDelayMs: 1_000,
                maxDelayMs: 15_000,
                label: `llm:${model}`,
                retryIf: (err) => {
                    if (err.httpStatus && isRetryableHttpStatus(err.httpStatus)) return true;
                    return isRetryableError(err);
                },
            }
        )
    );
}
