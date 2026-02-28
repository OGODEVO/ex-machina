import { secrets } from "./src/config.js";

async function run() {
    const res = await fetch(`http://rest.datafeeds.rolling-insights.com/api/v1/team-stats/NBA?RSC_token=${secrets.rscToken}`);
    const data = await res.json();
    console.log(JSON.stringify(data.data.NBA.slice(0, 1), null, 2));
}
run();
