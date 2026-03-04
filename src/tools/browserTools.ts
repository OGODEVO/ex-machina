/**
 * tools/browserTools.ts — Browser automation via Playwright.
 *
 * scrapePage: Navigate to a URL, extract visible text content.
 * browserAction: Navigate, click, fill forms, take screenshots, run JS.
 *
 * Uses a shared browser instance (lazy-launched, headless Chromium).
 * All pages auto-close after extraction to prevent memory leaks.
 */

import { chromium, type Browser, type Page } from "playwright";
import type { ToolSpec } from "./registry.js";

// ── Shared browser instance (lazy init) ──
let _browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
    if (!_browser || !_browser.isConnected()) {
        _browser = await chromium.launch({ headless: true });
    }
    return _browser;
}

/** Gracefully close the shared browser (call on shutdown). */
export async function closeBrowser(): Promise<void> {
    if (_browser) {
        await _browser.close();
        _browser = null;
    }
}

const PAGE_TIMEOUT_MS = 30_000;
const MAX_TEXT_CHARS = 8_000;
const ROTOWIRE_LINEUPS_URL = "https://www.rotowire.com/basketball/nba-lineups.php";

function truncate(text: string, max: number): string {
    if (text.length <= max) return text;
    return text.substring(0, max) + `\n\n... [truncated, ${text.length} total chars]`;
}

function toLocalYmd(date: Date = new Date()): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
}

type TeamLineup = {
    team: string;
    abbr?: string;
    status: "confirmed" | "unconfirmed" | "unknown";
    starters: Record<string, string>;
    starters_list: string[];
};

const NBA_TEAM_NAMES = [
    "Atlanta Hawks",
    "Boston Celtics",
    "Brooklyn Nets",
    "Charlotte Hornets",
    "Chicago Bulls",
    "Cleveland Cavaliers",
    "Dallas Mavericks",
    "Denver Nuggets",
    "Detroit Pistons",
    "Golden State Warriors",
    "Houston Rockets",
    "Indiana Pacers",
    "Los Angeles Clippers",
    "Los Angeles Lakers",
    "Memphis Grizzlies",
    "Miami Heat",
    "Milwaukee Bucks",
    "Minnesota Timberwolves",
    "New Orleans Pelicans",
    "New York Knicks",
    "Oklahoma City Thunder",
    "Orlando Magic",
    "Philadelphia 76ers",
    "Phoenix Suns",
    "Portland Trail Blazers",
    "Sacramento Kings",
    "San Antonio Spurs",
    "Toronto Raptors",
    "Utah Jazz",
    "Washington Wizards",
] as const;

const TEAM_ABBR_TO_NAME: Record<string, string> = {
    ATL: "Atlanta Hawks",
    BOS: "Boston Celtics",
    BKN: "Brooklyn Nets",
    CHA: "Charlotte Hornets",
    CHI: "Chicago Bulls",
    CLE: "Cleveland Cavaliers",
    DAL: "Dallas Mavericks",
    DEN: "Denver Nuggets",
    DET: "Detroit Pistons",
    GSW: "Golden State Warriors",
    HOU: "Houston Rockets",
    IND: "Indiana Pacers",
    LAC: "Los Angeles Clippers",
    LAL: "Los Angeles Lakers",
    MEM: "Memphis Grizzlies",
    MIA: "Miami Heat",
    MIL: "Milwaukee Bucks",
    MIN: "Minnesota Timberwolves",
    NOP: "New Orleans Pelicans",
    NYK: "New York Knicks",
    OKC: "Oklahoma City Thunder",
    ORL: "Orlando Magic",
    PHI: "Philadelphia 76ers",
    PHX: "Phoenix Suns",
    POR: "Portland Trail Blazers",
    SAC: "Sacramento Kings",
    SAS: "San Antonio Spurs",
    TOR: "Toronto Raptors",
    UTA: "Utah Jazz",
    WAS: "Washington Wizards",
};

function inferTeamFromContext(lines: string[], startIdx: number): string | null {
    const lo = Math.max(0, startIdx - 14);
    for (let i = startIdx - 1; i >= lo; i--) {
        const raw = lines[i].trim();
        if (!raw) continue;
        const upper = raw.toUpperCase();
        if (TEAM_ABBR_TO_NAME[upper]) return TEAM_ABBR_TO_NAME[upper];
        const lower = raw.toLowerCase();
        const match = NBA_TEAM_NAMES.find((team) => lower.includes(team.toLowerCase()));
        if (match) return match;
    }
    return null;
}

function normalizeStatusToken(line: string): TeamLineup["status"] {
    const t = line.toLowerCase();
    if (t.includes("confirmed")) return "confirmed";
    if (t.includes("unconfirmed") || t.includes("expected") || t.includes("projected")) return "unconfirmed";
    return "unknown";
}

function parseRotowireTeamLineups(pageText: string): TeamLineup[] {
    const positionOrder = ["PG", "SG", "SF", "PF", "C"];
    const isPos = (value: string) => positionOrder.includes(value.toUpperCase());

    const lines = pageText
        .split("\n")
        .map((line) => line.replace(/\s+/g, " ").trim())
        .filter(Boolean);

    const teamHeader = /^(.+?)\s+Lineup$/i;
    const statusHeader = /^(Confirmed|Unconfirmed|Expected|Projected)\s+Lineup$/i;
    const entries: TeamLineup[] = [];
    const genericLabels = new Set(["expected", "confirmed", "unconfirmed", "projected", "starting", "nba daily starting"]);

    const findStatusNear = (startIdx: number): TeamLineup["status"] => {
        const lo = Math.max(0, startIdx - 8);
        const hi = Math.min(lines.length - 1, startIdx + 22);
        let nearest: { dist: number; status: TeamLineup["status"] } | null = null;
        for (let i = lo; i <= hi; i++) {
            const status = normalizeStatusToken(lines[i]);
            if (status === "unknown") continue;
            const dist = Math.abs(i - startIdx);
            if (!nearest || dist < nearest.dist) nearest = { dist, status };
        }
        return nearest?.status ?? "unknown";
    };

    for (let i = 0; i < lines.length; i++) {
        const teamMatch = lines[i].match(teamHeader);
        const statusMatch = lines[i].match(statusHeader);
        if (!teamMatch && !statusMatch) continue;

        const rawLabel = (teamMatch?.[1] ?? statusMatch?.[1] ?? "").trim();
        const teamFromHeader = statusMatch ? inferTeamFromContext(lines, i) : rawLabel;
        const team = (teamFromHeader ?? rawLabel).trim();
        if (!team) continue;
        if (genericLabels.has(team.toLowerCase())) continue;
        const starters: Record<string, string> = {};

        for (let j = i + 1; j < lines.length; j++) {
            if (teamHeader.test(lines[j])) break;
            if (statusHeader.test(lines[j])) break;
            if (/^Inactives?$/i.test(lines[j])) break;
            if (/^News$/i.test(lines[j])) break;

            const inline = lines[j].match(/^(PG|SG|SF|PF|C)\s*[:\-]?\s+(.+)$/i);
            if (inline) {
                starters[inline[1].toUpperCase()] = inline[2].trim();
                continue;
            }

            if (isPos(lines[j]) && j + 1 < lines.length) {
                const player = lines[j + 1].trim();
                if (!isPos(player) && !teamHeader.test(player) && !/^Inactives?$/i.test(player)) {
                    starters[lines[j].toUpperCase()] = player;
                }
            }
        }

        if (Object.keys(starters).length >= 3) {
            entries.push({
                team,
                status: normalizeStatusToken(lines[i]) !== "unknown" ? normalizeStatusToken(lines[i]) : findStatusNear(i),
                starters,
                starters_list: positionOrder.map((p) => starters[p]).filter(Boolean),
            });
        }
    }

    // Keep best unique lineup per team (prefer one with more captured positions).
    const byTeam = new Map<string, TeamLineup>();
    for (const entry of entries) {
        const key = entry.team.toLowerCase();
        const existing = byTeam.get(key);
        if (!existing || Object.keys(entry.starters).length > Object.keys(existing.starters).length) {
            byTeam.set(key, entry);
        }
    }
    return Array.from(byTeam.values());
}

function matchesTeamFilter(team: string, filter: string): boolean {
    const f = filter.trim().toLowerCase();
    if (!f) return true;
    const t = team.toLowerCase();
    if (t.includes(f) || f.includes(t)) return true;
    const abbr = Object.entries(TEAM_ABBR_TO_NAME).find(([, name]) => name.toLowerCase() === t)?.[0]?.toLowerCase();
    if (abbr && (abbr === f || f.includes(abbr))) return true;
    return false;
}

type RotowireGameLineup = {
    time_et: string;
    away: TeamLineup;
    home: TeamLineup;
};

function buildTeamLineupFromSlots(team: string, abbr: string, status: TeamLineup["status"], slots: Array<{ pos: string; name: string }>): TeamLineup {
    const order = ["PG", "SG", "SF", "PF", "C"];
    const starters: Record<string, string> = {};
    for (const slot of slots) {
        const pos = slot.pos.toUpperCase();
        if (!order.includes(pos)) continue;
        if (!starters[pos]) starters[pos] = slot.name.trim();
    }
    return {
        team: team.trim(),
        abbr: abbr.trim(),
        status,
        starters,
        starters_list: order.map((p) => starters[p]).filter(Boolean),
    };
}

function parseRotowireLineupCards(cards: any[]): RotowireGameLineup[] {
    const games: RotowireGameLineup[] = [];
    for (const card of cards) {
        if (!card) continue;
        const away = buildTeamLineupFromSlots(card.away_team || card.away_abbr || "Away", card.away_abbr || "", card.away_status || "unknown", card.away_slots || []);
        const home = buildTeamLineupFromSlots(card.home_team || card.home_abbr || "Home", card.home_abbr || "", card.home_status || "unknown", card.home_slots || []);

        // Keep only real lineup cards with meaningful starters on both sides.
        if (away.starters_list.length < 3 || home.starters_list.length < 3) continue;
        games.push({
            time_et: String(card.time_et || "").trim(),
            away,
            home,
        });
    }
    return games;
}

// ──────────────────────────────────────────
// Tool 1: scrapePage — read content from a URL
// ──────────────────────────────────────────

export const scrapePageTool: ToolSpec = {
    name: "scrapePage",
    description:
        "Navigate to a specific URL and extract the visible text content of the page. " +
        "Use this when you need to read a specific webpage, documentation page, box score, " +
        "article, or any content at a known URL. Returns clean text, not raw HTML.",
    parameters: {
        type: "object",
        properties: {
            url: {
                type: "string",
                description: "The full URL to navigate to and scrape (e.g., 'https://espn.com/game/12345').",
            },
            waitForSelector: {
                type: "string",
                description: "Optional CSS selector to wait for before extracting content (e.g., '.game-stats'). Useful for SPAs that load data dynamically.",
            },
        },
        required: ["url"],
    },
    execute: async (args: { url: string; waitForSelector?: string }, _ctx) => {
        let page: Page | null = null;
        try {
            const browser = await getBrowser();
            page = await browser.newPage();

            await page.goto(args.url, {
                timeout: PAGE_TIMEOUT_MS,
                waitUntil: "domcontentloaded",
            });

            // If caller wants to wait for a specific element
            if (args.waitForSelector) {
                await page.waitForSelector(args.waitForSelector, { timeout: 10_000 }).catch(() => {
                    // Don't fail if selector not found, still return what we have
                });
            }

            // Small delay for any JS rendering
            await page.waitForTimeout(1500);

            // Extract visible text (strips HTML, scripts, styles)
            const title = await page.title();
            const textContent = await page.evaluate(`
                (function() {
                    var scripts = document.querySelectorAll('script, style, noscript');
                    scripts.forEach(function(s) { s.remove(); });
                    return document.body ? document.body.innerText : '';
                })()
            `) as string;

            const cleaned = (textContent || "")
                .split("\n")
                .map((line: string) => line.trim())
                .filter((line: string) => line.length > 0)
                .join("\n");

            return `PAGE: ${title}\nURL: ${args.url}\n\n${truncate(cleaned, MAX_TEXT_CHARS)}`;
        } catch (err: any) {
            if (err.name === "TimeoutError") {
                return `Scrape timed out after ${PAGE_TIMEOUT_MS / 1000}s for: ${args.url}`;
            }
            return `Scrape failed: ${err.message}`;
        } finally {
            if (page) await page.close().catch(() => { });
        }
    },
};

// ──────────────────────────────────────────
// Tool 2: browserAction — interact with a page
// ──────────────────────────────────────────

type BrowserStep =
    | { action: "goto"; url: string }
    | { action: "click"; selector: string }
    | { action: "fill"; selector: string; value: string }
    | { action: "wait"; selector: string }
    | { action: "screenshot" }
    | { action: "getText"; selector?: string }
    | { action: "evaluate"; script: string };

export const browserActionTool: ToolSpec = {
    name: "browserAction",
    description:
        "Execute a sequence of browser actions on a page: navigate, click, fill forms, " +
        "wait for elements, take screenshots, extract text, or run JavaScript. " +
        "Use this for multi-step interactions like logging into a site, filling search forms, " +
        "or extracting data that requires clicking through multiple pages.",
    parameters: {
        type: "object",
        properties: {
            steps: {
                type: "array",
                description: `Array of action steps to execute in order. Each step is an object with an "action" field. Supported actions:
- { "action": "goto", "url": "https://..." } — navigate to URL
- { "action": "click", "selector": "#button" } — click an element
- { "action": "fill", "selector": "#input", "value": "text" } — type into input
- { "action": "wait", "selector": ".results" } — wait for element to appear
- { "action": "screenshot" } — capture the current page (returns base64)
- { "action": "getText", "selector": ".data" } — extract text from element (omit selector for full page)
- { "action": "evaluate", "script": "document.title" } — run arbitrary JS and return result`,
                items: { type: "object" },
            },
        },
        required: ["steps"],
    },
    execute: async (args: { steps: BrowserStep[] }, _ctx) => {
        let page: Page | null = null;
        const results: string[] = [];

        try {
            const browser = await getBrowser();
            page = await browser.newPage();

            for (let i = 0; i < args.steps.length; i++) {
                const step = args.steps[i];
                const label = `Step ${i + 1}/${args.steps.length}`;

                try {
                    switch (step.action) {
                        case "goto":
                            await page.goto(step.url, { timeout: PAGE_TIMEOUT_MS, waitUntil: "domcontentloaded" });
                            results.push(`${label}: Navigated to ${step.url}`);
                            break;

                        case "click":
                            await page.click(step.selector, { timeout: 10_000 });
                            results.push(`${label}: Clicked "${step.selector}"`);
                            break;

                        case "fill":
                            await page.fill(step.selector, step.value, { timeout: 10_000 });
                            results.push(`${label}: Filled "${step.selector}" with "${step.value}"`);
                            break;

                        case "wait":
                            await page.waitForSelector(step.selector, { timeout: 10_000 });
                            results.push(`${label}: Element "${step.selector}" appeared`);
                            break;

                        case "screenshot": {
                            const buf = await page.screenshot({ type: "png" });
                            const b64 = buf.toString("base64").substring(0, 500);
                            results.push(`${label}: Screenshot captured (${buf.length} bytes, base64 truncated)`);
                            break;
                        }

                        case "getText": {
                            let text: string;
                            if (step.selector) {
                                const el = await page.$(step.selector);
                                text = el ? (await el.innerText()) : "Element not found.";
                            } else {
                                text = await page.evaluate(`document.body ? document.body.innerText : ''`) as string;
                            }
                            const cleaned = (text || "").split("\n").map((l: string) => l.trim()).filter((l: string) => l).join("\n");
                            results.push(`${label}: Text extracted:\n${truncate(cleaned, 4000)}`);
                            break;
                        }

                        case "evaluate": {
                            let evalResult: unknown;
                            try {
                                // Primary path: treat input as a JS expression or IIFE string.
                                evalResult = await page.evaluate(step.script);
                            } catch (exprErr: any) {
                                // Fallback path: support function-body scripts that use top-level return.
                                // This prevents "Illegal return statement" from breaking common LLM-generated snippets.
                                evalResult = await page.evaluate(
                                    (code) => {
                                        const fn = new Function(code);
                                        return fn();
                                    },
                                    step.script
                                );
                            }
                            results.push(`${label}: JS result: ${JSON.stringify(evalResult)}`);
                            break;
                        }

                        default:
                            results.push(`${label}: Unknown action "${(step as any).action}"`);
                    }
                } catch (stepErr: any) {
                    results.push(`${label}: FAILED — ${stepErr.message}`);
                    // Continue with remaining steps instead of aborting
                }
            }

            return results.join("\n\n");
        } catch (err: any) {
            return `Browser automation failed: ${err.message}\n\nCompleted steps:\n${results.join("\n")}`;
        } finally {
            if (page) await page.close().catch(() => { });
        }
    },
};

// ──────────────────────────────────────────
// Tool 3: getRotowireLineups — deterministic NBA lineup parser
// ──────────────────────────────────────────

export const getRotowireLineupsTool: ToolSpec = {
    name: "getRotowireLineups",
    description:
        "Fetch NBA daily lineups from Rotowire and return structured lineup data with confirmed/unconfirmed status. " +
        "Use this for lineup tasks instead of freeform browser steps.",
    parameters: {
        type: "object",
        properties: {
            date: {
                type: "string",
                description: "Optional date label (YYYY-MM-DD) for your report. Rotowire endpoint is today's lineup page.",
            },
            team: {
                type: "string",
                description: "Optional team filter (e.g., 'Lakers', 'LAL', 'Phoenix Suns').",
            },
        },
        required: [],
    },
    execute: async (args: { date?: string; team?: string }, _ctx) => {
        let page: Page | null = null;
        try {
            const browser = await getBrowser();
            page = await browser.newPage();

            await page.goto(ROTOWIRE_LINEUPS_URL, {
                timeout: PAGE_TIMEOUT_MS,
                waitUntil: "domcontentloaded",
            });
            await page.waitForTimeout(2000);

            // Best-effort waits for lineup containers on dynamic loads.
            await page.waitForSelector(".lineup, .lineup-card, [class*='lineup']", { timeout: 8_000 }).catch(() => { });

            const title = await page.title();
            const bodyText = await page.evaluate(`
                (function() {
                    var scripts = document.querySelectorAll('script, style, noscript');
                    scripts.forEach(function(s) { s.remove(); });
                    return document.body ? document.body.innerText : '';
                })()
            `) as string;

            const domCards = await page.evaluate(`
                (() => {
                    const clean = (s) => (s ?? "").replace(/\\s+/g, " ").trim();
                    const parseStatus = (statusText, className) => {
                        const txt = \`\${statusText} \${className}\`.toLowerCase();
                        if (txt.includes("confirmed") && !txt.includes("unconfirmed")) return "confirmed";
                        if (txt.includes("unconfirmed") || txt.includes("expected") || txt.includes("projected")) return "unconfirmed";
                        return "unknown";
                    };
                    const parseTeamName = (el) => {
                        if (!el) return "";
                        const clone = el.cloneNode(true);
                        clone.querySelectorAll(".lineup__wl").forEach((n) => n.remove());
                        return clean(clone.textContent);
                    };
                    const parseSlots = (listEl) => {
                        if (!listEl) return [];
                        const rows = Array.from(listEl.querySelectorAll(".lineup__player"));
                        const out = [];
                        for (const row of rows) {
                            const pos = clean(row.querySelector(".lineup__pos")?.textContent).toUpperCase();
                            if (!["PG", "SG", "SF", "PF", "C"].includes(pos)) continue;
                            const clone = row.cloneNode(true);
                            clone.querySelectorAll(".lineup__pos, .lineup__inj").forEach((n) => n.remove());
                            const name = clean(clone.textContent);
                            if (name) out.push({ pos, name });
                        }
                        return out;
                    };

                    const cards = Array.from(document.querySelectorAll(".lineups .lineup.is-nba"))
                        .filter((card) => !card.classList.contains("is-tools"));

                    return cards.map((card) => {
                        const awayAbbr = clean(card.querySelector(".lineup__team.is-visit .lineup__abbr")?.textContent);
                        const homeAbbr = clean(card.querySelector(".lineup__team.is-home .lineup__abbr")?.textContent);
                        const awayTeam = parseTeamName(card.querySelector(".lineup__mteam.is-visit"));
                        const homeTeam = parseTeamName(card.querySelector(".lineup__mteam.is-home"));
                        const awayList = card.querySelector(".lineup__list.is-visit");
                        const homeList = card.querySelector(".lineup__list.is-home");
                        const awayStatusEl = awayList?.querySelector(".lineup__status");
                        const homeStatusEl = homeList?.querySelector(".lineup__status");

                        return {
                            time_et: clean(card.querySelector(".lineup__time")?.textContent),
                            away_abbr: awayAbbr,
                            home_abbr: homeAbbr,
                            away_team: awayTeam,
                            home_team: homeTeam,
                            away_status: parseStatus(clean(awayStatusEl?.textContent), clean(awayStatusEl?.className || "")),
                            home_status: parseStatus(clean(homeStatusEl?.textContent), clean(homeStatusEl?.className || "")),
                            away_slots: parseSlots(awayList),
                            home_slots: parseSlots(homeList),
                        };
                    });
                })()
            `);

            const domCardsAny = Array.isArray(domCards) ? domCards : [];
            let games = parseRotowireLineupCards(domCardsAny);
            const parsed = games.flatMap((g) => [g.away, g.home]);

            // Fallback if card parser fails (site layout changed / partial render).
            if (games.length === 0) {
                const fallbackTeams = parseRotowireTeamLineups(bodyText || "");
                if (fallbackTeams.length > 0) {
                    // Build pseudo games in pairs for response consistency.
                    for (let i = 0; i < fallbackTeams.length; i += 2) {
                        const away = fallbackTeams[i];
                        const home = fallbackTeams[i + 1];
                        if (!away || !home) break;
                        games.push({ time_et: "", away, home });
                    }
                }
            }

            const teamFilter = args.team?.trim().toLowerCase();
            const filteredGames = teamFilter
                ? games.filter((g) =>
                    matchesTeamFilter(g.away.team, teamFilter)
                    || matchesTeamFilter(g.home.team, teamFilter)
                    || (g.away.abbr ? matchesTeamFilter(g.away.abbr, teamFilter) : false)
                    || (g.home.abbr ? matchesTeamFilter(g.home.abbr, teamFilter) : false)
                )
                : games;

            const filteredTeams = filteredGames.flatMap((g) => [g.away, g.home]);
            const knownTeams = (games.flatMap((g) => [g.away.team, g.home.team])).filter(Boolean);

            const payload = {
                source: ROTOWIRE_LINEUPS_URL,
                page_title: title,
                date: args.date ?? toLocalYmd(),
                fetched_at: new Date().toISOString(),
                match_found: filteredGames.length > 0,
                requested_team: args.team ?? null,
                total_games_parsed: filteredGames.length,
                parsed_teams_snapshot: knownTeams.slice(0, 20),
                games: filteredGames.map((game) => ({
                    time_et: game.time_et || null,
                    away: {
                        team: game.away.team,
                        abbr: game.away.abbr ?? null,
                        status: game.away.status,
                        starters: {
                            PG: game.away.starters.PG ?? null,
                            SG: game.away.starters.SG ?? null,
                            SF: game.away.starters.SF ?? null,
                            PF: game.away.starters.PF ?? null,
                            C: game.away.starters.C ?? null,
                        },
                        starters_list: game.away.starters_list,
                    },
                    home: {
                        team: game.home.team,
                        abbr: game.home.abbr ?? null,
                        status: game.home.status,
                        starters: {
                            PG: game.home.starters.PG ?? null,
                            SG: game.home.starters.SG ?? null,
                            SF: game.home.starters.SF ?? null,
                            PF: game.home.starters.PF ?? null,
                            C: game.home.starters.C ?? null,
                        },
                        starters_list: game.home.starters_list,
                    },
                })),
                teams: filteredTeams.map((entry) => ({
                    team: entry.team,
                    abbr: entry.abbr ?? null,
                    status: entry.status,
                    starters: {
                        PG: entry.starters.PG ?? null,
                        SG: entry.starters.SG ?? null,
                        SF: entry.starters.SF ?? null,
                        PF: entry.starters.PF ?? null,
                        C: entry.starters.C ?? null,
                    },
                    starters_list: entry.starters_list,
                })),
            };
            return JSON.stringify(payload, null, 2);
        } catch (err: any) {
            if (err.name === "TimeoutError") {
                return `Rotowire lineup fetch timed out after ${PAGE_TIMEOUT_MS / 1000}s.`;
            }
            return `Rotowire lineup fetch failed: ${err.message}`;
        } finally {
            if (page) await page.close().catch(() => { });
        }
    },
};
