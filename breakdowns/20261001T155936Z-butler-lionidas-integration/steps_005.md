# Step 5 — Sources live + the Lionidas system prompt + agent eval

- **Status:** Ready
- **Plan:** rev 2, Stage 4; completion condition 7 (+ the prompt that makes drills behave)
- **Depends on:** Step 4 (storage + retriever wired through context)

## Outcome and boundaries

Fixture tickets + the Lionidas repo itself ingest through real connectors and are searchable; Jira connector fixture-tested only (I3); the domain system prompt is real content; the authoring eval (mock provider, CI-hermetic) passes against the REAL validator. Out of scope: Hermes drill (Step 6).

## Implementation instructions

### 5a. Fixture tickets
`server/test/fixtures/agent-tickets/` (git-tracked): 2–3 markdown tickets in the house ticket shape (the butler demo fixtures are the model — DEMO-101 style: requirement, context with screen ids from a seeded registry, acceptance lines). These double as the eval inputs.

### 5b. `sources.ts` — connector builders + seeding
```ts
import { fileConnector, repoConnector, jiraConnector, ingest } from '@mainactordev/butler';
export function fileSource(root: string) { return fileConnector('lionidas-files', { root }); }
export function repoSource(origin: string, symbols = true) { return repoConnector('lionidas-repo', { origin, symbols }); }
export function jiraSource(cfg, fetchImpl?) { return jiraConnector('lionidas-jira', cfg, fetchImpl); } // env-gated live; fixture tests only (I3)
```
Boot-time seed (in `context.ts`, idempotent — content-addressed ingest skips unchanged): ingest the fixture dir + OPTIONALLY the Lionidas repo root (`repoSource(repoRoot)` — symbol chunks over `shared/src` = the step grammar as code). Repo seed size-capped via butler defaults; make repo seeding env-toggleable (`AGENT_INGEST_REPO=1`, default on locally, note for CI).

### 5c. `system-prompt.ts` — real content (grounded in `shared/src/case-yaml.ts`)
Structure (~40 lines max):
1. Role: test-case author for Lionidas; one sentence what Lionidas is.
2. Grammar summary: the step kinds actually supported (tap/type/expect/…), `narrate:` per step for acceptance criteria, `app:` + `folder:` keys, variants `network:` pin (from the shipped grammar — re-verify against case-yaml.ts at write time).
3. Rules: ALWAYS `screens.registry` before drafting (ids must exist); ALWAYS `case.draft.save` (the validator decides validity — never claim valid without its result); cite source docs by sha prefix; notes are for learned pitfalls with provenance.
4. Refusal awareness: play/device are act-class — tell the user a human plays cases.

### 5d. Jira fixture test
Recorded-response `fetchImpl` (butler's stage-3 pattern): issue JSON → normalized doc → field chunks; assert `sources.search` finds it after ingest. No live network (I3).

### 5e. The authoring eval (`server/test/agent-eval.test.ts`)
Fixture ticket → MockProvider scripted to: `sources.search` → `case.draft.save`(invalid) → repair → `case.draft.save`(valid) → final answer. Judge = REAL validator re-run on the created template row (query the DB; assert `status='draft'` + `parseCaseYaml(renderTemplateYaml(row))` parses). Canary: a deliberately-wrong judge expectation fails the suite (metric, not crash — butler's F7 discipline).

## Verification

```bash
cd server && pnpm vitest run test/agent-eval.test.ts test/agent-sources.test.ts
pnpm typecheck && pnpm vitest run
```
Manual sanity (local only): boot server → `sources.ingest {kind:'file', root: fixtures}` via an operator-authenticated agent session → `sources.search "login"` returns DEMO-ticket chunks.

## Completion gate

- [ ] fixtures tracked; file+repo connectors live; repo symbol chunks present in chunks table
- [ ] Jira connector green on recorded fixtures; zero live Jira calls anywhere in CI
- [ ] system prompt references real grammar (spot-checked against case-yaml.ts)
- [ ] eval green incl. canary; full suite green
