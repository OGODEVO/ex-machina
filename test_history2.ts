import { AgentNetClient } from "agentnet-sdk";
import "dotenv/config";

async function run() {
    const client = new AgentNetClient({
        natsUrl: process.env.NATS_URL || "nats://localhost:4222",
        agentId: "test_history_dumper2",
        name: "test",
    });
    await client.start();
    const threads = await client.listThreads({limit: 5});
    console.log("Found threads:", threads.map(t => t.id || t.thread_id));
    for (const t of threads) {
        const id = t.id || t.thread_id;
        if (id.includes("agent2")) {
            const res = await client.getThreadMessages(id, { limit: 2 });
            console.log(JSON.stringify(res, null, 2));
            break;
        }
    }
    await client.close();
}
run();
