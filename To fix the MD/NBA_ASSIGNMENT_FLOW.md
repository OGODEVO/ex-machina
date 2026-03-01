# NBA Assignment Flow Fix (Agent 0 -> Agent 2 -> Agent 0 -> Agent 1/3 Debate)

## Problem To Fix
When Agent 0 asks Agent 2 for NBA pre-game analysis, behavior is sometimes inconsistent:
- chat-mode and task-mode get mixed
- Agent 2 may return in the wrong format
- Agent 0 may continue unrelated actions instead of finalizing
- Agent 1 and Agent 3 do not always receive a complete dossier for debate picks

This document defines the required deterministic contract.

## Mode Contract (Must Be Enforced In Runtime)

1. `chat` mode
- Incoming payload type is `chat`
- Worker returns normal chat reply only
- Worker must not use `markTaskDone` / `reportError`

2. `assign` mode
- Incoming payload type is `assign`
- Worker must terminate with exactly one:
  - `markTaskDone`
  - `reportError`
- Raw text is not terminal in strict mode

## Completion Contract

1. Agent 0 sends assignment to Agent 2 on request/reply channel.
2. Agent 2 runtime sends terminal payload directly on reply channel when available.
3. Agent 0 treats terminal payload as assignment completion (no thread scraping in primary path).
4. Agent 0 either:
- returns synthesized output to user, or
- forwards dossier to Agent 1 and Agent 3 for debate.

## Agent 2 Required NBA Dossier Fields
Agent 2 NBA pre-game analysis is invalid unless all required fields are present.

Required fields:
1. `game_context`
- matchup
- date/time (with timezone)
- venue

2. `team_stats`
- offensive metrics (PPG, FG%, 3P%, FT%, ORB, AST, TOV)
- defensive metrics (opp PPG or defensive rating proxies, BLK/STL, rebounding context)

3. `injury_report`
- each key player status (OUT/QUESTIONABLE/PROBABLE/etc.)
- expected impact summary

4. `odds`
- spread
- moneyline
- total
- sportsbook/source + timestamp

5. `recent_form`
- last 5 and/or last 10 form for both teams
- trend summary (pace, net margin, offense/defense trend)

6. `sources`
- URLs or feed names used
- timestamp of retrieval

## Agent 2 Output Template (Use This Shape)

```markdown
## NBA_PRE_GAME_DOSSIER

### game_context
- matchup:
- tipoff_local:
- venue:

### team_stats
- team_a_offense:
- team_a_defense:
- team_b_offense:
- team_b_defense:

### injury_report
- team_a:
- team_b:
- impact:

### odds
- spread:
- moneyline:
- total:
- source:
- retrieved_at:

### recent_form
- team_a_last_10:
- team_b_last_10:
- trend_summary:

### sources
- [1]
- [2]
```

## Agent 0 Validation Rule (Before Debate)
Agent 0 must validate the dossier contains all required sections above.

If missing fields:
1. Agent 0 sends a targeted follow-up assignment to Agent 2 listing missing sections.
2. Agent 0 does not start debate until dossier is complete.

## Debate Handoff Rule
Once complete dossier passes validation:
1. Agent 0 sends same dossier to Agent 1 and Agent 3.
2. Agent 1 and Agent 3 produce picks/reasoning from the same data pack.
3. Agent 0 synthesizes final recommendation to user.

## Deterministic Success Criteria
A run is successful only if all are true:
1. Agent 2 returns terminal `DONE` in assign mode.
2. Agent 2 output includes all required NBA dossier fields.
3. Agent 0 either requests missing fields or proceeds to debate with complete dossier.
4. Agent 0 returns a final user-facing response with the synthesized pick rationale.
