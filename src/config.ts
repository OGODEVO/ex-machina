import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));

function withDefaultNatsUrl(value: string | undefined): string {
    if (value && value.trim()) return value.trim();
    // Keep default aligned with AgentNet docs and local docker stack auth.
    return "nats://agentnet_secret_token@localhost:4222";
}

export function redactNatsUrl(url: string): string {
    return url.replace(/\/\/.*@/, "//***@");
}

// ── Secrets from .env ──
export const secrets = {
    openaiApiKey: process.env.OPENAI_API_KEY ?? "",
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
    novitaApiKey: process.env.NOVITA_API_KEY ?? "",
    perplexityApiKey: process.env.PERPLEXITY_API_KEY ?? "",
    rscToken: process.env.RSC_TOKEN ?? "",
    natsUrl: withDefaultNatsUrl(process.env.NATS_URL),
    orchestratorId: process.env.ORCHESTRATOR_ID ?? "orchestrator_v1",
    orchestratorName: process.env.ORCHESTRATOR_NAME ?? "Orchestrator",
} as const;

export type ShellMode = "strict" | "relaxed" | "open";

export interface AgentModelConfig {
    model: string;
    base_url: string;
    max_tokens: number;
    shell_mode?: ShellMode;
}

const yamlPath = resolve(__dirname, "..", "config", "agents.yaml");
const yamlContent = readFileSync(yamlPath, "utf-8");
const agentConfigs = parseYaml(yamlContent) as Record<string, AgentModelConfig>;

/** Get model config for a specific agent. Falls back to orchestrator config. */
export function getAgentModelConfig(agentId: string): AgentModelConfig {
    const cfg = agentConfigs[agentId];
    if (cfg) return cfg;

    // Fallback to orchestrator config
    return agentConfigs.orchestrator ?? {
        model: "gpt-5.1",
        base_url: "https://api.openai.com/v1",
        max_tokens: 4096,
    };
}

/** Get shell mode for an agent. Returns undefined if agent has no shell access. */
export function getAgentShellMode(agentId: string): ShellMode | undefined {
    return agentConfigs[agentId]?.shell_mode;
}
