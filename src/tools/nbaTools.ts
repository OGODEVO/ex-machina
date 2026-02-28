/**
 * tools/nbaTools.ts — NBA data tools powered by Rolling Insights DataFeeds API.
 *
 * Three tools for Agent 2:
 *   1. getDailySchedule — Find today's games, team IDs, game IDs.
 *   2. preGameAnalysis  — Aggregated pre-game dossier (team stats, injuries, depth charts).
 *   3. liveGameAnalysis — Live box score snapshot (team + player stats).
 *
 * Includes a baked-in team name → ID resolver so the LLM never has to guess IDs.
 */

import type { ToolSpec } from "./registry.js";
import { secrets } from "../config.js";
import { withRetry, CircuitBreaker, isRetryableHttpStatus, isRetryableError } from "../resilience.js";

// ── Constants ──

const BASE_URL = "http://rest.datafeeds.rolling-insights.com/api/v1";

const rscBreaker = new CircuitBreaker("rolling-insights", {
    failureThreshold: 4,
    cooldownMs: 20_000,
});

// ── Team Name → ID Resolver ──

const TEAM_MAP: Record<string, number> = {
    // 1 - Minnesota Timberwolves
    "minnesota timberwolves": 1, "timberwolves": 1, "wolves": 1, "min": 1, "minnesota": 1,
    // 2 - Indiana Pacers
    "indiana pacers": 2, "pacers": 2, "ind": 2, "indiana": 2,
    // 3 - Utah Jazz
    "utah jazz": 3, "jazz": 3, "uta": 3, "utah": 3,
    // 4 - Orlando Magic
    "orlando magic": 4, "magic": 4, "orl": 4, "orlando": 4,
    // 5 - Atlanta Hawks
    "atlanta hawks": 5, "hawks": 5, "atl": 5, "atlanta": 5,
    // 6 - Boston Celtics
    "boston celtics": 6, "celtics": 6, "bos": 6, "boston": 6,
    // 7 - Cleveland Cavaliers
    "cleveland cavaliers": 7, "cavaliers": 7, "cavs": 7, "cle": 7, "cleveland": 7,
    // 8 - New York Knicks
    "new york knicks": 8, "knicks": 8, "nyk": 8, "ny": 8, "new york": 8,
    // 9 - New Orleans Pelicans
    "new orleans pelicans": 9, "pelicans": 9, "nop": 9, "no": 9, "new orleans": 9,
    // 10 - Portland Trail Blazers
    "portland trail blazers": 10, "trail blazers": 10, "blazers": 10, "por": 10, "portland": 10,
    // 11 - Memphis Grizzlies
    "memphis grizzlies": 11, "grizzlies": 11, "mem": 11, "memphis": 11,
    // 12 - Los Angeles Lakers
    "los angeles lakers": 12, "lakers": 12, "lal": 12, "l.a. lakers": 12,
    // 13 - Oklahoma City Thunder
    "oklahoma city thunder": 13, "thunder": 13, "okc": 13, "oklahoma city": 13,
    // 14 - Dallas Mavericks
    "dallas mavericks": 14, "mavericks": 14, "mavs": 14, "dal": 14, "dallas": 14,
    // 15 - Houston Rockets
    "houston rockets": 15, "rockets": 15, "hou": 15, "houston": 15,
    // 16 - Denver Nuggets
    "denver nuggets": 16, "nuggets": 16, "den": 16, "denver": 16,
    // 17 - Philadelphia 76ers
    "philadelphia 76ers": 17, "76ers": 17, "sixers": 17, "phi": 17, "philadelphia": 17,
    // 18 - Brooklyn Nets
    "brooklyn nets": 18, "nets": 18, "bkn": 18, "brooklyn": 18,
    // 19 - Sacramento Kings
    "sacramento kings": 19, "kings": 19, "sac": 19, "sacramento": 19,
    // 20 - Miami Heat
    "miami heat": 20, "heat": 20, "mia": 20, "miami": 20,
    // 21 - Golden State Warriors
    "golden state warriors": 21, "warriors": 21, "gsw": 21, "gs": 21, "golden state": 21, "dubs": 21,
    // 22 - Chicago Bulls
    "chicago bulls": 22, "bulls": 22, "chi": 22, "chicago": 22,
    // 23 - Los Angeles Clippers
    "la clippers": 23, "clippers": 23, "lac": 23, "los angeles clippers": 23,
    // 24 - Phoenix Suns
    "phoenix suns": 24, "suns": 24, "phx": 24, "phoenix": 24,
    // 25 - Milwaukee Bucks
    "milwaukee bucks": 25, "bucks": 25, "mil": 25, "milwaukee": 25,
    // 26 - Detroit Pistons
    "detroit pistons": 26, "pistons": 26, "det": 26, "detroit": 26,
    // 27 - Charlotte Hornets
    "charlotte hornets": 27, "hornets": 27, "cha": 27, "charlotte": 27,
    // 28 - San Antonio Spurs
    "san antonio spurs": 28, "spurs": 28, "sas": 28, "sa": 28, "san antonio": 28,
    // 29 - Washington Wizards
    "washington wizards": 29, "wizards": 29, "was": 29, "wsh": 29, "washington": 29,
    // 30 - Toronto Raptors
    "toronto raptors": 30, "raptors": 30, "tor": 30, "toronto": 30,
};

/** Resolve a team name/abbreviation/ID to the canonical integer ID. */
function resolveTeam(input: string | number): number | null {
    if (typeof input === "number") return input;
    const str = String(input).trim();
    if (/^\d+$/.test(str)) return parseInt(str, 10);
    return TEAM_MAP[str.toLowerCase()] ?? null;
}

// ── Shared API Fetch Helper ──

async function rscFetch(path: string, params: Record<string, string> = {}): Promise<any> {
    const token = secrets.rscToken;
    if (!token) throw new Error("RSC_TOKEN is not set in .env");

    const url = new URL(`${BASE_URL}/${path}`);
    url.searchParams.set("RSC_token", token);
    for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
    }

    return rscBreaker.call(() =>
        withRetry(
            async () => {
                const res = await fetch(url.toString(), {
                    method: "GET",
                    signal: AbortSignal.timeout(30_000),
                });

                if (!res.ok) {
                    const errText = await res.text().catch(() => "unknown");
                    const err = new Error(`RSC API error (${res.status}): ${errText}`);
                    (err as any).httpStatus = res.status;
                    throw err;
                }

                return res.json();
            },
            {
                maxRetries: 2,
                baseDelayMs: 1_500,
                maxDelayMs: 10_000,
                label: `rsc:${path}`,
                retryIf: (err) => {
                    if (err.httpStatus && isRetryableHttpStatus(err.httpStatus)) return true;
                    return isRetryableError(err);
                },
            }
        )
    );
}

/** Truncate a string to a max character count to prevent context overflow. */
function truncate(str: string, max: number = 12_000): string {
    if (str.length <= max) return str;
    return str.substring(0, max) + `\n\n... [TRUNCATED — ${str.length - max} chars omitted]`;
}

// ── Tool 1: getDailySchedule ──

export const getDailyScheduleTool: ToolSpec = {
    name: "getDailySchedule",
    description:
        "Get today's NBA game schedule (or a specific date). Returns a list of matchups with team IDs and game IDs. Use this FIRST to find the game_ID or team_IDs you need for preGameAnalysis or liveGameAnalysis.",
    parameters: {
        type: "object",
        properties: {
            date: {
                type: "string",
                description: "Date in YYYY-MM-DD format. Defaults to today if omitted.",
            },
            team: {
                type: "string",
                description: "Optional team name or abbreviation to filter (e.g. 'Lakers', 'LAL', '12').",
            },
        },
        required: [],
    },
    execute: async (args: { date?: string; team?: string }, _ctx) => {
        const date = args.date ?? new Date().toISOString().split("T")[0];
        const params: Record<string, string> = {};

        if (args.team) {
            const teamId = resolveTeam(args.team);
            if (teamId) params.team_id = String(teamId);
            else return `Could not resolve team "${args.team}". Try a full team name, abbreviation, or numeric ID.`;
        }

        try {
            const data = await rscFetch(`schedule/${date}/NBA`, params);
            const games = data?.data?.NBA;

            if (!games || games.length === 0) {
                return `No NBA games found for ${date}.`;
            }

            const lines = games.map((g: any, i: number) => {
                const status = g.status ?? "unknown";
                const time = g.game_time ?? "";
                return (
                    `[${i + 1}] ${g.away_team} (ID:${g.away_team_ID}) @ ${g.home_team} (ID:${g.home_team_ID})\n` +
                    `    Game ID: ${g.game_ID} | Status: ${status} | Time: ${time}\n` +
                    `    Season: ${g.season} | Type: ${g.season_type}` +
                    (g.broadcast ? ` | TV: ${g.broadcast}` : "")
                );
            });

            return `NBA Schedule for ${date} (${games.length} games):\n\n${lines.join("\n\n")}`;
        } catch (err: any) {
            if (err.message?.includes("circuit-breaker")) return err.message;
            return `Failed to fetch schedule: ${err.message}`;
        }
    },
};

// ── Tool 2: preGameAnalysis ──

export const preGameAnalysisTool: ToolSpec = {
    name: "preGameAnalysis",
    description:
        "Get a comprehensive pre-game dossier for two NBA teams. Fetches team season stats, injuries, and depth charts in ONE call. Pass team names, abbreviations, or IDs.",
    parameters: {
        type: "object",
        properties: {
            teamA: {
                type: "string",
                description: "First team (name, abbreviation, or ID). Example: 'Lakers', 'LAL', or '12'.",
            },
            teamB: {
                type: "string",
                description: "Second team (name, abbreviation, or ID). Example: 'Warriors', 'GSW', or '21'.",
            },
            season: {
                type: "string",
                description: "Season year (YYYY). Defaults to current season if omitted.",
            },
        },
        required: ["teamA", "teamB"],
    },
    execute: async (args: { teamA: string; teamB: string; season?: string }, _ctx) => {
        const idA = resolveTeam(args.teamA);
        const idB = resolveTeam(args.teamB);
        if (!idA) return `Could not resolve team "${args.teamA}". Try full name, abbreviation, or ID.`;
        if (!idB) return `Could not resolve team "${args.teamB}". Try full name, abbreviation, or ID.`;

        try {
            // Fire all 3 API calls in parallel
            const [statsData, injuriesData, depthData] = await Promise.all([
                rscFetch(args.season ? `team-stats/${args.season}/NBA` : "team-stats/NBA"),
                rscFetch("injuries/NBA"),
                rscFetch("depth-charts/NBA"),
            ]);

            // ── Extract team stats ──
            const allTeamStats = statsData?.data?.NBA ?? [];
            const statsA = allTeamStats.find((t: any) => t.team_id === idA);
            const statsB = allTeamStats.find((t: any) => t.team_id === idB);

            // ── Extract injuries ──
            const allInjuries = injuriesData?.data?.NBA ?? [];
            const injA = allInjuries.find((t: any) => t.team_id === idA);
            const injB = allInjuries.find((t: any) => t.team_id === idB);

            // ── Extract depth charts ──
            const allDepth = depthData?.data?.NBA ?? {};
            // Depth charts are keyed by team name, not ID, so we need to find the right key
            let depthA: any = null;
            let depthB: any = null;
            for (const [teamName, chart] of Object.entries(allDepth)) {
                if ((chart as any).team_id === idA) depthA = { team: teamName, chart };
                if ((chart as any).team_id === idB) depthB = { team: teamName, chart };
            }

            // ── Format the dossier ──
            const sections: string[] = [];

            sections.push("=== PRE-GAME ANALYSIS DOSSIER ===\n");

            // Team A Stats
            if (statsA) {
                sections.push(`## ${statsA.team} (ID: ${idA}) — Season Stats`);
                const rs = statsA.regular_season;
                if (rs) {
                    sections.push(
                        `Games: ${rs.games_played} | Points: ${rs.points} | PPG: ${(rs.points / rs.games_played).toFixed(1)}\n` +
                        `FG: ${rs.field_goals_made}/${rs.field_goals_attempted} | 3PT: ${rs.three_points_made}/${rs.three_points_attempted} | FT: ${rs.free_throws_made}/${rs.free_throws_attempted}\n` +
                        `Rebounds: ${rs.total_rebounds} (Off: ${rs.offensive_rebounds}, Def: ${rs.defensive_rebounds})\n` +
                        `Assists: ${rs.assists} | Steals: ${rs.steals} | Blocks: ${rs.blocks} | Turnovers: ${rs.turnovers} | Fouls: ${rs.fouls}`
                    );
                }
            }

            // Team B Stats
            if (statsB) {
                sections.push(`\n## ${statsB.team} (ID: ${idB}) — Season Stats`);
                const rs = statsB.regular_season;
                if (rs) {
                    sections.push(
                        `Games: ${rs.games_played} | Points: ${rs.points} | PPG: ${(rs.points / rs.games_played).toFixed(1)}\n` +
                        `FG: ${rs.field_goals_made}/${rs.field_goals_attempted} | 3PT: ${rs.three_points_made}/${rs.three_points_attempted} | FT: ${rs.free_throws_made}/${rs.free_throws_attempted}\n` +
                        `Rebounds: ${rs.total_rebounds} (Off: ${rs.offensive_rebounds}, Def: ${rs.defensive_rebounds})\n` +
                        `Assists: ${rs.assists} | Steals: ${rs.steals} | Blocks: ${rs.blocks} | Turnovers: ${rs.turnovers} | Fouls: ${rs.fouls}`
                    );
                }
            }

            // Injuries
            const formatInjuries = (inj: any) => {
                if (!inj?.injuries?.length) return "  No reported injuries.";
                return inj.injuries
                    .map((i: any) => `  • ${i.player} — ${i.injury} (Returns: ${i.returns ?? "Unknown"})`)
                    .join("\n");
            };
            sections.push(`\n## Injury Report`);
            sections.push(`**${injA?.team ?? `Team ${idA}`}**:\n${formatInjuries(injA)}`);
            sections.push(`**${injB?.team ?? `Team ${idB}`}**:\n${formatInjuries(injB)}`);

            // Depth Charts
            const formatDepth = (d: any) => {
                if (!d?.chart) return "  No depth chart data.";
                const positions = ["PG", "SG", "SF", "PF", "C"];
                return positions
                    .map((pos) => {
                        const slot = d.chart[pos];
                        if (!slot) return `  ${pos}: N/A`;
                        const players = Object.entries(slot)
                            .filter(([k]) => k !== "team_id")
                            .sort(([a], [b]) => Number(a) - Number(b))
                            .map(([rank, p]: [string, any]) => `${rank}. ${p.player}`)
                            .join(", ");
                        return `  ${pos}: ${players}`;
                    })
                    .join("\n");
            };
            sections.push(`\n## Depth Charts`);
            sections.push(`**${depthA?.team ?? `Team ${idA}`}**:\n${formatDepth(depthA)}`);
            sections.push(`**${depthB?.team ?? `Team ${idB}`}**:\n${formatDepth(depthB)}`);

            return truncate(sections.join("\n"));
        } catch (err: any) {
            if (err.message?.includes("circuit-breaker")) return err.message;
            return `Pre-game analysis failed: ${err.message}`;
        }
    },
};

// ── Tool 3: liveGameAnalysis ──

export const liveGameAnalysisTool: ToolSpec = {
    name: "liveGameAnalysis",
    description:
        "Get live or completed game box score data. Returns current score, quarter, team stats, and top player performances. Pass a game_ID (from getDailySchedule) or a date + team name.",
    parameters: {
        type: "object",
        properties: {
            gameId: {
                type: "string",
                description: "The game_ID (e.g. '20231111-12-21'). Get this from getDailySchedule first.",
            },
            date: {
                type: "string",
                description: "Game date in YYYY-MM-DD format. Required if using team instead of gameId.",
            },
            team: {
                type: "string",
                description: "Team name/abbreviation. Used with date to find the game if gameId is not known.",
            },
        },
        required: [],
    },
    execute: async (args: { gameId?: string; date?: string; team?: string }, _ctx) => {
        const date = args.date ?? new Date().toISOString().split("T")[0];
        const params: Record<string, string> = {};

        if (args.gameId) {
            params.game_id = args.gameId;
        } else if (args.team) {
            const teamId = resolveTeam(args.team);
            if (teamId) params.team_id = String(teamId);
            else return `Could not resolve team "${args.team}".`;
        }

        try {
            const data = await rscFetch(`live/${date}/NBA`, params);
            const games = data?.data?.NBA;

            if (!games || games.length === 0) {
                return `No live/completed game data found for ${date}.`;
            }

            const sections: string[] = [];

            for (const game of games.slice(0, 3)) { // cap at 3 games max to save tokens
                const away = game.full_box?.away_team;
                const home = game.full_box?.home_team;
                const current = game.full_box?.current;

                sections.push(`=== ${game.away_team_name ?? away?.mascot} @ ${game.home_team_name ?? home?.mascot} ===`);
                sections.push(`Game ID: ${game.game_ID} | Status: ${game.game_status ?? game.status}`);
                if (current) {
                    sections.push(`Quarter: ${current.Quarter} | Time: ${current.TimeRemaining ?? "N/A"}`);
                }
                sections.push(`Score: ${away?.mascot} ${away?.score} - ${home?.score} ${home?.mascot}`);
                sections.push(`Records: ${away?.mascot} (${away?.record}) vs ${home?.mascot} (${home?.record})`);

                // Team stats comparison
                if (away?.team_stats && home?.team_stats) {
                    const as = away.team_stats;
                    const hs = home.team_stats;
                    sections.push(
                        `\nTeam Stats:\n` +
                        `  FG: ${as.field_goals_made}/${as.field_goals_attempted} vs ${hs.field_goals_made}/${hs.field_goals_attempted}\n` +
                        `  3PT: ${as.three_points_made}/${as.three_points_attempted} vs ${hs.three_points_made}/${hs.three_points_attempted}\n` +
                        `  FT: ${as.free_throws_made}/${as.free_throws_attempted} vs ${hs.free_throws_made}/${hs.free_throws_attempted}\n` +
                        `  Rebounds: ${as.total_rebounds} vs ${hs.total_rebounds}\n` +
                        `  Assists: ${as.assists} vs ${hs.assists}\n` +
                        `  Turnovers: ${as.turnovers} vs ${hs.turnovers}\n` +
                        `  Steals: ${as.steals} vs ${hs.steals} | Blocks: ${as.blocks} vs ${hs.blocks}`
                    );
                }

                // Quarter scores
                if (away?.quarter_scores) {
                    const qs = Object.entries(away.quarter_scores).map(([q, s]) =>
                        `Q${q}: ${s}-${home?.quarter_scores?.[q] ?? "?"}`
                    ).join(" | ");
                    sections.push(`Quarter Scores: ${qs}`);
                }

                // Top players (sort by points, take top 5 per team)
                const formatTopPlayers = (playerBox: any, label: string) => {
                    if (!playerBox) return "";
                    const players = Object.values(playerBox) as any[];
                    const sorted = players
                        .filter((p) => p.status === "ACT" && p.minutes)
                        .sort((a, b) => (b.points ?? 0) - (a.points ?? 0))
                        .slice(0, 5);

                    if (sorted.length === 0) return "";
                    const lines = sorted.map((p) =>
                        `  ${p.player} (${p.position}): ${p.points}pts, ${p.total_rebounds}reb, ${p.assists}ast, ` +
                        `${p.field_goals_made}/${p.field_goals_attempted}FG, ${p.three_points_made}/${p.three_points_attempted}3PT, ` +
                        `${p.minutes}min`
                    );
                    return `\n${label} Top Performers:\n${lines.join("\n")}`;
                };

                sections.push(formatTopPlayers(game.player_box?.away_team, away?.mascot ?? "Away"));
                sections.push(formatTopPlayers(game.player_box?.home_team, home?.mascot ?? "Home"));
                sections.push(""); // blank line between games
            }

            return truncate(sections.join("\n"));
        } catch (err: any) {
            if (err.message?.includes("circuit-breaker")) return err.message;
            return `Live game analysis failed: ${err.message}`;
        }
    },
};
