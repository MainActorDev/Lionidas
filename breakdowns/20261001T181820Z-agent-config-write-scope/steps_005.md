# Step 5 — Prompt/instructions update + docs + live Hermes drill + closeout

- **Status:** Ready
- **Plan:** rev 2, Stage S5, conditions 7, 8 (+ repo gates)
- **Repo:** Step 4 head
- **Depends on:** Steps 1–4 all gated green

## Outcome

The agent KNOWS its config-author scope (prompt + MCP instructions), docs reflect the new tool table, and a live Hermes drill exercises the whole path with logged ids. Out of scope: route-level fixes (observations #1/#2), web UI.

## Implementation

### 5a. system-prompt.ts — config-author section (append; keep it terse)

```
## Config authoring (suites, scenarios, presets)
- You may list, create and edit suites, network scenarios and traffic presets. Errors come back VERBATIM — fix per the message, retry once.
- Suites are single-app: every member's bundle must match (the first member sets the scope unless appBundleId is given).
- Scenarios referenced by runs are IMMUTABLE — the tool refuses; duplicate the scenario and edit the copy.
- Case lifecycle: editing an active case goes through case.draft.revise (it lands as a NEW draft; the live case is never touched). case.deprecate retires on request.
- Humans do the rest: activation (cases/suites/scenarios), deletion, playing runs, devices. Never promise otherwise.
```

### 5b. docs/agent.md — tool table gains the new rows (read: suites/scenarios/presets; draft: suite/scenario/preset save/edit + revise + deprecate); state the act-class exclusions table gets `scenario activate`, `all deletes`.

### 5c. MCP instructions smoke — bare-launch initialize; assert the section rides along (`config-author`, `immutable`, `revise` substrings). (Existing smoke script pattern; extend `/Volumes/.../scratch/smoke-instructions.sh` or inline.)

### 5d. THE DRILL (live, Hermes; operator watching or this session's terminal as fallback)

Restart Hermes → prompt:

> "Create a network scenario 'lp1042-payment-error' with a preset that returns status 502 on path /v2/payments/authorize, then a suite 'Checkout regression' containing the LP-1042 draft case, then revise the LP-1042 case to add a step expecting payment-web.loading."

Expected trace: `preset.draft.save` → `scenario.draft.save` (or members.set) → `suite.draft.save` (bundle scope resolves from the member) → `case.draft.revise` (active? no — the LP-1042 case is a DRAFT, so this last one should hit the revise guard and the agent should switch to case.draft.edit — the drill LOGS that honest bounce as a feature). Verify each artifact: `GET /api/forge/scenarios/s_…`, `GET /api/suites`, `GET /api/templates/:id/yaml`; sync spy equivalent = `/api/forge/presets` shows the new preset AND a manual `POST /api/forge/mode {}` no-op doesn't error (proxy state consistent). Log everything (ids, hops, tokens, refusals) in `docs/agent-drills.md` under a new dated section.

### 5e. Closeout gates

`pnpm vitest run` (server full) · web `pnpm build` · cli `pnpm vitest run` · `npx tsc --noEmit` · butler `git status` clean · `git -C ../butler log origin/main -1` = `cc138a1`. Push; PR #14 already open (human merges). Update `docs/agent.md` drill pointer.

## Verification

- Instructions smoke contains the new section substrings.
- Drill artifacts exist and are correct (per-route GETs); drill log committed.
- All repo gates green; no `activate`/`delete` tool names anywhere (re-run Step 4's registry sweep assertion in the full suite context).

## Completion gate

- [ ] instructions carry the config-author section (smoke output pasted in drill log)
- [ ] drill completed through Hermes with real ids logged; honest bounce captured
- [ ] docs/agent.md table updated; repo gates green; pushed
