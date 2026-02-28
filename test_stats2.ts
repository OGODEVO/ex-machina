import { secrets } from "./src/config.js";

async function run() {
    for (const p of ["team-stats/NBA", "team-stats/2025-26/NBA", "team-stats/2025/NBA", "team-stats/2026/NBA"]) {
        console.log("Fetching", p);
        try {
            const res = await fetch(`http://rest.datafeeds.rolling-insights.com/api/v1/${p}?RSC_token=${secrets.rscToken}`);
            const data = await res.json();
            console.log(p, "returned", Array.isArray(data?.data?.NBA) ? data.data.NBA.length + " teams" : "Not an array");
        } catch (e: any) {
            console.log(p, "error", e.message);
        }
    }
}
run();
