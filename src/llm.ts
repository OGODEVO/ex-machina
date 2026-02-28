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

function resolveApiKey(baseUrl: string): string {
    if (baseUrl.includes("anthropic.com")) return secrets.anthropicApiKey;
    if (baseUrl.includes("novita.ai")) return secrets.novitaApiKey;
    return secrets.openaiApiKey;
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
    const apiKey = resolveApiKey(baseUrl);

    const body: Record<string, unknown> = {
        model,
        messages,
        temperature: options.temperature ?? 0.3,
    };
    // Newer OpenAI models (gpt-5.x, o-series, gpt-4.1+) require max_completion_tokens
    if (maxTokens) {
        const useNewParam = /^(gpt-5|gpt-4\.1|o[1-9]|o[1-9]-)/i.test(model);
        body[useNewParam ? "max_completion_tokens" : "max_tokens"] = maxTokens;
    }
    if (options.stop?.length) body.stop = options.stop;
    if (options.tools && options.tools.length > 0) body.tools = options.tools;

    const breaker = getBreaker(baseUrl);

    return breaker.call(() =>
        withRetry(
            async () => {
                const isAnthropic = baseUrl.includes("anthropic.com");

                let fetchUrl = `${baseUrl}/chat/completions`;
                let fetchHeaders: Record<string, string> = {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${apiKey}`,
                };
                let fetchBody: Record<string, unknown> = body;

                if (isAnthropic) {
                    fetchUrl = `${baseUrl}/messages`;
                    fetchHeaders = {
                        "Content-Type": "application/json",
                        "x-api-key": apiKey,
                        "anthropic-version": "2023-06-01",
                    };
                    const sysMsgs = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
                    const userMsgs = messages.filter((m) => m.role !== "system");

                    fetchBody = {
                        model,
                        max_tokens: maxTokens || 4096,
                        temperature: options.temperature ?? 0.3,
                        system: sysMsgs || undefined,
                        messages: userMsgs,
                    };
                    if (options.tools && options.tools.length > 0) {
                        fetchBody.tools = options.tools.map((t) => ({
                            name: t.function.name,
                            description: t.function.description || "",
                            input_schema: t.function.parameters || { type: "object", properties: {} },
                        }));
                    }
                }

                const res = await fetch(fetchUrl, {
                    method: "POST",
                    headers: fetchHeaders,
                    body: JSON.stringify(fetchBody),
                    signal: AbortSignal.timeout(120_000),
                });

                if (!res.ok) {
                    const errText = await res.text().catch(() => "unknown");
                    const err = new Error(`LLM request failed (${res.status}): ${errText}`);
                    // Tag retryable status so withRetry knows to retry
                    (err as any).httpStatus = res.status;
                    throw err;
                }

                const data = await res.json() as any;
                if (data.error?.message) throw new Error(`LLM error: ${data.error.message}`);

                if (isAnthropic) {
                    if (data.stop_reason === "tool_use" || data.content?.some((c: any) => c.type === "tool_use")) {
                        const tc = data.content.find((c: any) => c.type === "tool_use");
                        return JSON.stringify({
                            _isToolCall: true,
                            name: tc.name,
                            arguments: JSON.stringify(tc.input),
                        });
                    }
                    return data.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("") ?? "";
                }

                const openaiData = data as OpenAIResponse;
                const message = openaiData.choices?.[0]?.message;
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
