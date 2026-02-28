/**
 * resilience.ts — Retry, backoff, cooldown, and circuit breaker utilities.
 *
 * Usage:
 *   import { withRetry, CircuitBreaker } from "./resilience.js";
 *
 *   // Simple retry with exponential backoff
 *   const result = await withRetry(() => fetch(url), { maxRetries: 3 });
 *
 *   // Circuit breaker wrapping a service
 *   const llmBreaker = new CircuitBreaker("llm", { failureThreshold: 3, cooldownMs: 30_000 });
 *   const result = await llmBreaker.call(() => chatCompletion(msgs));
 */

// ── Retry with Exponential Backoff ──

export interface RetryOptions {
    /** Max number of retries (default: 3) */
    maxRetries?: number;
    /** Initial delay in ms before first retry (default: 1000) */
    baseDelayMs?: number;
    /** Max delay cap in ms (default: 15000) */
    maxDelayMs?: number;
    /** Which errors should trigger a retry (default: all) */
    retryIf?: (error: any) => boolean;
    /** Label for logging */
    label?: string;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute an async function with exponential backoff retries.
 * Retries on any error by default, or only errors matching `retryIf`.
 */
export async function withRetry<T>(
    fn: () => Promise<T>,
    opts: RetryOptions = {}
): Promise<T> {
    const {
        maxRetries = 3,
        baseDelayMs = 1_000,
        maxDelayMs = 15_000,
        retryIf,
        label = "operation",
    } = opts;

    let lastError: any;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err: any) {
            lastError = err;

            // Check if this error is retryable
            if (retryIf && !retryIf(err)) {
                throw err; // Not retryable, fail immediately
            }

            if (attempt >= maxRetries) {
                break; // Out of retries
            }

            // Exponential backoff with jitter
            const delay = Math.min(
                baseDelayMs * Math.pow(2, attempt) + Math.random() * 500,
                maxDelayMs
            );
            console.log(
                `[retry] ${label} failed (attempt ${attempt + 1}/${maxRetries + 1}), ` +
                `retrying in ${Math.round(delay)}ms: ${err.message ?? err}`
            );
            await sleep(delay);
        }
    }

    throw lastError;
}

// ── Retryable Error Detection Helpers ──

/** Returns true for HTTP errors that are worth retrying (429, 500, 502, 503, 504). */
export function isRetryableHttpStatus(status: number): boolean {
    return status === 429 || status >= 500;
}

/** Returns true for common transient network errors. */
export function isRetryableError(err: any): boolean {
    if (err.name === "TimeoutError" || err.name === "AbortError") return true;
    if (err.code === "ECONNRESET" || err.code === "ECONNREFUSED") return true;
    if (err.code === "ETIMEDOUT" || err.code === "EPIPE") return true;
    const msg = String(err.message ?? "").toLowerCase();
    if (msg.includes("rate limit") || msg.includes("too many requests")) return true;
    if (msg.includes("network") || msg.includes("socket")) return true;
    return false;
}

// ── Circuit Breaker ──

type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
    /** How many consecutive failures before opening the circuit (default: 5) */
    failureThreshold?: number;
    /** How long (ms) the circuit stays open before allowing a test request (default: 30000) */
    cooldownMs?: number;
    /** Label for logging */
    label?: string;
}

/**
 * Circuit Breaker pattern.
 *
 * CLOSED: calls pass through normally. Failures are counted.
 * OPEN: all calls immediately fail with a fast error (no network call). Saves resources.
 * HALF-OPEN: after cooldown, one test call is allowed. If it succeeds → CLOSED. If it fails → OPEN again.
 */
export class CircuitBreaker {
    private state: CircuitState = "closed";
    private failureCount = 0;
    private lastFailureTime = 0;

    private readonly failureThreshold: number;
    private readonly cooldownMs: number;
    private readonly label: string;

    constructor(label: string, opts: CircuitBreakerOptions = {}) {
        this.label = label;
        this.failureThreshold = opts.failureThreshold ?? 5;
        this.cooldownMs = opts.cooldownMs ?? 30_000;
    }

    /** Execute a function through the circuit breaker. */
    async call<T>(fn: () => Promise<T>): Promise<T> {
        // OPEN: reject immediately unless cooldown has passed
        if (this.state === "open") {
            const elapsed = Date.now() - this.lastFailureTime;
            if (elapsed < this.cooldownMs) {
                const remaining = Math.round((this.cooldownMs - elapsed) / 1000);
                throw new Error(
                    `[circuit-breaker] ${this.label} is OPEN. ` +
                    `${this.failureCount} consecutive failures. ` +
                    `Retry in ${remaining}s.`
                );
            }
            // Cooldown passed → try one request
            this.state = "half-open";
            console.log(`[circuit-breaker] ${this.label}: HALF-OPEN — testing one request`);
        }

        try {
            const result = await fn();
            // Success → reset
            if (this.state === "half-open") {
                console.log(`[circuit-breaker] ${this.label}: test passed → CLOSED`);
            }
            this.state = "closed";
            this.failureCount = 0;
            return result;
        } catch (err) {
            this.failureCount++;
            this.lastFailureTime = Date.now();

            if (this.failureCount >= this.failureThreshold || this.state === "half-open") {
                this.state = "open";
                console.log(
                    `[circuit-breaker] ${this.label}: OPEN after ${this.failureCount} failures. ` +
                    `Cooldown: ${this.cooldownMs / 1000}s`
                );
            }
            throw err;
        }
    }

    /** Get current circuit state (for diagnostics). */
    getState(): { state: CircuitState; failures: number; label: string } {
        return { state: this.state, failures: this.failureCount, label: this.label };
    }
}
