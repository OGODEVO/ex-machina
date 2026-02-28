/**
 * tools/searchTools.ts — Web search via Perplexity Search API.
 *
 * Endpoint: POST https://api.perplexity.ai/search
 * Auth: Bearer token via PERPLEXITY_API_KEY
 * Docs: https://docs.perplexity.ai/docs/search/quickstart
 */

import type { ToolSpec } from "./registry.js";
import { secrets } from "../config.js";

interface PerplexityResult {
    title: string;
    url: string;
    snippet: string;
    date?: string;
}

interface PerplexitySearchResponse {
    results: PerplexityResult[];
    id?: string;
    error?: { message?: string };
}

/**
 * Tool: searchWeb
 * Performs a real-time web search via Perplexity's Search API.
 * Returns ranked results with titles, URLs, and content snippets.
 */
export const searchWebTool: ToolSpec = {
    name: "searchWeb",
    description: "Search the internet for real-time information using the Perplexity Search API. Returns ranked web results with titles, URLs, and content snippets. Use this for current events, stats, research, documentation, or any factual question you cannot answer from memory.",
    parameters: {
        type: "object",
        properties: {
            query: {
                type: "string",
                description: "The search query. Be specific and detailed for better results.",
            },
            maxResults: {
                type: "number",
                description: "Number of results to return (1-20). Default: 5.",
            },
            country: {
                type: "string",
                description: "Optional ISO country code (e.g. 'US', 'GB') to get geographically relevant results.",
            },
        },
        required: ["query"],
    },
    execute: async (args: { query: string; maxResults?: number; country?: string }, _ctx) => {
        const apiKey = secrets.perplexityApiKey;
        if (!apiKey) {
            return "Error: PERPLEXITY_API_KEY is not set. Cannot perform web search.";
        }

        const body: Record<string, unknown> = {
            query: args.query,
            max_results: args.maxResults ?? 5,
            max_tokens_per_page: 2048,
        };
        if (args.country) body.country = args.country;

        try {
            const res = await fetch("https://api.perplexity.ai/search", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(30_000), // 30s timeout
            });

            if (!res.ok) {
                const errText = await res.text().catch(() => "unknown");
                return `Search API error (${res.status}): ${errText}`;
            }

            const data = (await res.json()) as PerplexitySearchResponse;
            if (data.error?.message) {
                return `Search API error: ${data.error.message}`;
            }

            if (!data.results || data.results.length === 0) {
                return `No results found for: "${args.query}"`;
            }

            // Format results for the LLM to digest
            const formatted = data.results.map((r, i) => {
                const date = r.date ? ` (${r.date})` : "";
                const snippet = r.snippet
                    ? r.snippet.substring(0, 500)
                    : "No snippet available.";
                return `[${i + 1}] ${r.title}${date}\n    URL: ${r.url}\n    ${snippet}`;
            }).join("\n\n");

            return `Search results for "${args.query}" (${data.results.length} results):\n\n${formatted}`;
        } catch (err: any) {
            if (err.name === "TimeoutError") {
                return "Search timed out after 30 seconds. Try a simpler query.";
            }
            return `Search failed: ${err.message}`;
        }
    },
};

/**
 * Tool: deepSearch
 * Multi-query search for comprehensive research across multiple angles.
 * Sends up to 5 queries in a single request.
 */
export const deepSearchTool: ToolSpec = {
    name: "deepSearch",
    description: "Perform a comprehensive multi-angle search by sending up to 5 related queries at once. Use this when researching a topic from multiple perspectives (e.g., stats + news + analysis).",
    parameters: {
        type: "object",
        properties: {
            queries: {
                type: "array",
                items: { type: "string" },
                description: "Array of 2-5 related search queries to research different angles of a topic.",
            },
            maxResultsPerQuery: {
                type: "number",
                description: "Number of results per query (1-10). Default: 3.",
            },
        },
        required: ["queries"],
    },
    execute: async (args: { queries: string[]; maxResultsPerQuery?: number }, _ctx) => {
        const apiKey = secrets.perplexityApiKey;
        if (!apiKey) {
            return "Error: PERPLEXITY_API_KEY is not set. Cannot perform web search.";
        }

        if (args.queries.length > 5) {
            return "Error: Maximum 5 queries per deep search request.";
        }

        try {
            const res = await fetch("https://api.perplexity.ai/search", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    query: args.queries,
                    max_results: args.maxResultsPerQuery ?? 3,
                    max_tokens_per_page: 1024,
                }),
                signal: AbortSignal.timeout(60_000), // 60s for multi-query
            });

            if (!res.ok) {
                const errText = await res.text().catch(() => "unknown");
                return `Search API error (${res.status}): ${errText}`;
            }

            const data = (await res.json()) as { results: PerplexityResult[][] };

            // Format grouped results per query
            const formatted = args.queries.map((q, qi) => {
                const queryResults = data.results[qi] || [];
                if (queryResults.length === 0) return `## Query ${qi + 1}: "${q}"\nNo results found.`;

                const items = queryResults.map((r, i) => {
                    const snippet = r.snippet ? r.snippet.substring(0, 300) : "No snippet.";
                    return `  [${i + 1}] ${r.title}\n      URL: ${r.url}\n      ${snippet}`;
                }).join("\n\n");

                return `## Query ${qi + 1}: "${q}"\n${items}`;
            }).join("\n\n---\n\n");

            return `Deep search results (${args.queries.length} queries):\n\n${formatted}`;
        } catch (err: any) {
            if (err.name === "TimeoutError") {
                return "Deep search timed out after 60 seconds. Try fewer queries.";
            }
            return `Deep search failed: ${err.message}`;
        }
    },
};
