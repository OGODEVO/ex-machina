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

function truncate(text: string, max: number): string {
    if (text.length <= max) return text;
    return text.substring(0, max) + `\n\n... [truncated, ${text.length} total chars]`;
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
                            const evalResult = await page.evaluate(step.script);
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
