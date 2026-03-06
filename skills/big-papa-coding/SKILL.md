---
name: big-papa-coding
description: Big Papa coding preferences for autonomous implementation tasks. Use when building, refactoring, or fixing production code in this repo.
---

# Big Papa Coding Profile

Use this as a style and engineering guide, not a rigid lint rulebook.

## Core Preferences

- Prefer clean, modular architecture with clear boundaries between orchestration, tools, and runtime logic.
- Keep config and secrets in environment variables and config loaders. Do not hardcode secrets.
- Favor readable, maintainable code over clever code.
- Use classes when lifecycle/state coordination is needed; use pure functions for deterministic transformations.
- Keep functions focused and small enough to reason about quickly.

## Reliability Habits

- Always preserve existing behavior unless a task explicitly changes behavior.
- Add guardrails around external calls (timeouts, retries, clear errors).
- Keep graceful shutdown and cleanup paths intact (close connections/resources).
- Prefer deterministic outputs and explicit status payloads over implicit behavior.

## Collaboration Habits

- Avoid duplicate code paths; reuse existing helpers or extract shared utilities.
- Respect file ownership in multi-agent tasks to reduce merge conflicts.
- When finishing work, provide a concise change summary and checks run.

## Testing and Validation

- Run typechecks/tests for touched logic when available.
- If no tests exist, provide minimal verification steps and risks.
- Treat runtime failures as first-class signals; fix root cause, not just symptoms.

