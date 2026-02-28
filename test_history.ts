import { AgentNetClient } from "agentnet-sdk";
import "dotenv/config";

async function run() {
    const client = new AgentNetClient({
        natsUrl: process.env.NATS_URL || "nats://localhost:4222",
        agentId: "test_history_dumper",
        name: "test",
    });
    await client.start();
    const res = await client.getThreadMessages("cli_mm6qw47z::agent2_orchestrator_v1::r1", { limit: 1 });
    console.log(JSON.stringify(res, null, 2));
    await client.close();
}
run();
