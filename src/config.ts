import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Secrets from .env ──
export const secrets = {
    openaiApiKey: process.env.OPENAI_API_KEY ?? "",
    perplexityApiKey: process.env.PERPLEXITY_API_KEY ?? "",
    natsUrl: process.env.NATS_URL ?? "nats://agentnet_secret_token@localhost:4222",
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
        model: "gpt-4o",
        base_url: "https://api.openai.com/v1",
        max_tokens: 4096,
    };
}

/** Get shell mode for an agent. Returns undefined if agent has no shell access. */
export function getAgentShellMode(agentId: string): ShellMode | undefined {
    return agentConfigs[agentId]?.shell_mode;
}
