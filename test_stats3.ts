import { secrets } from "./src/config.js";

async function run() {
    for (const p of ["team-stats/NBA", "team-stats/2025/NBA", "team-stats/2026/NBA"]) {
        try {
            const res = await fetch(`http://rest.datafeeds.rolling-insights.com/api/v1/${p}?RSC_token=${secrets.rscToken}`);
            const data = await res.json();
            const rs = data?.data?.NBA?.[0]?.regular_season;
            console.log(p, "returned:", rs ? `${rs.games_played} games` : "No stats");
        } catch (e: any) {
            console.log(p, "error", e.message);
        }
    }
}
run();
