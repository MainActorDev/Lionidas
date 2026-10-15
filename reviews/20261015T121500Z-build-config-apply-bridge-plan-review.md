# Review — Build-Config Apply Bridge Plan

- Plan reviewed: `plans/20261015T121500Z-build-config-apply-bridge-plan.md` (READY)
- Evidence: `src/agent/{identifier-flow,config-tools,draft-tools,commands,context}.ts`, `src/projects/{builds,build-configs}.ts`, butler v0.6.2 seams (`src/tools.ts` ctx.sessionId, transport afterTurn), live session forensics (sess_88dd9de5-f19, sess_dfd724a6-b6c)
- Review date: 2026-10-15
- Verdict: **Needs revision** — 1 High, 3 Medium; all plan-text corrections. No operator decisions outstanding.

## Coverage

All five principles trace to design elements: hard stop → command instructions + confirmation precondition; structural gate → pending-proposal check; secrets → file-placement-only law + verify-fails-honestly; oracle → startBuildVerify reuse; append-only → writeBuildConfigRevision reuse. Acceptance is testable and includes the negative case. What was checked on paper: tool-registration seams (ctx.sessionId confirmed at butler src/tools.ts:17), storage access patterns (sessionMessages confirmed), store/verify function reuse, state-machine consistency with the identifier-flow sibling. What needs execution: the B3 live drill, obviously.

## Findings

### R1 — HIGH: the confirmation check as specified is spoofable by the agent itself

- Location: Design §2, `build_config.apply` precondition — "a confirmation message from the user exists AFTER the proposal turn (checked against butler_messages)"
- Evidence: butler_messages rows carry only role+content; the apply tool executes inside the AGENT's turn. If the model paraphrases the user or (pathologically) the conversation contains an earlier "confirmed" from a *different* proposal, the check passes on text alone. Worse: the plan's fallback "parse the answer's yaml block" (§1) puts the structured data under the model's pen, not the tool's.
- Consequence: the "structural gate" is structural only about the parked row existing — the human-confirmation half remains prompt-trust with extra steps.
- Correction: make the gate genuinely structural with a one-sided write path: `build_config.propose` parks `pending`; ONLY the turn-decoration seam (butler `prepareTurn`, same as identifier-flow) can flip `pending → applied` — it fires on the user's NEXT message matching CONFIRM_RE, before the model sees the turn. The `build_config.apply` tool then only succeeds when state is ALREADY `applied` (it performs the write; the flip is not its to do). The model can call apply all it wants on a `pending` row — the tool refuses. This is exactly the identifier-flow mechanism already proven in production; the plan should adopt it wholesale instead of inventing a message-text check.
- Verify fix: plan text §2 rewritten: flip via prepareTurn decoration; apply-tool precondition = state==='applied'.

### R2 — MEDIUM: `build_config.propose` as the only parking source breaks the current command contract

- Location: Design §1 + §2
- Evidence: today's `/build-config-propose` instructions tell the model to render a markdown table and stop; the live sessions produced yaml-in-prose with notes. If parking depends on the model calling a new tool mid-turn, a model that forgets (or paraphrases into prose) parks nothing — and the confirmation turn then has nothing to flip. The plan acknowledges this with a "fallback parse of the answer's yaml block" — fragile.
- Consequence: intermittent dead-end — the exact gap this plan exists to kill, reintroduced probabilistically.
- Correction: two-layer parking, both in `afterTurn`: (a) if `build_config.propose` was called, park its structured args (canonical); (b) ALWAYS also run the answer-level detector (same as identifier-flow's answerIsProposal) and park/refresh from the yaml code block when (a) didn't fire. Belt and braces; the tool remains the preferred path and gives cleaner fields, but the loop survives a prose-only turn.
- Verify fix: §1 amended with the dual-layer park.

### R3 — MEDIUM: verify-fire from inside the tool conflates turn lifetime with build lifetime

- Location: Design §2 — apply "fires `startBuildVerify` (fire-and-forget)"
- Evidence: `startBuildVerify` shares builds.ts's module state — fine — but the verdict lands minutes later on the REVISION row. The apply tool's return promises `{verifyStarted}`; the model will report "verify running". That's correct. But the plan's B3 drill then asserts "verdict lands" without specifying WHO observes it — the session ends, the poll that would render it lives in the Projects page.
- Consequence: minor — a green/failed verdict exists but nobody narrates it into the chat unless the user returns.
- Correction (design choice, cheap): after verify settles, write a note (kind env-gate, scope project) with the verdict + log tail — notes surface in future sessions via ranked injection, so the next turn in that chat learns the outcome without new machinery. Optionally also an event on the WS bus. Keep it best-effort.
- Verify fix: §2/§5 gains "verify outcome → durable note (best-effort) so later turns see it".

### R4 — MEDIUM: migration ordering — the proposals table must be created by migrateBuildConfigs, not ad-hoc

- Location: Design §1 table DDL
- Evidence: identifier_proposals is ensureTable'd inside identifier-flow.ts (lazy CREATE). That pattern worked, but this plan introduces the table in a NEW module while migrateBuildConfigs already owns build-config schema; two owners for one domain's schema invites drift (the FK lesson from the rename: schema bits scattered across modules get missed).
- Consequence: a fresh DB where config-tools loads before migrateBuildConfigs runs → runtime no-such-table in the tool path.
- Correction: DDL for `build_config_proposals` lives in `migrateBuildConfigs` (schema.ts) alongside build_configs; the flow module assumes it exists.
- Verify fix: §1 names schema.ts as the DDL home.

### R5 — LOW: session-keyed proposals vs multi-project sessions

- Location: Design §1 (session_id PRIMARY KEY)
- Evidence: a session could legitimately propose for two projects (the user did exactly this pattern in sess_dfd724a6-b6c follow-ups). New propose REPLACES pending — a second project's proposal silently discards the first.
- Consequence: annoying, not dangerous (the replaced proposal was never confirmed; the notes still exist).
- Correction: key on (session_id, project_id); apply consumes the matching project row. Keep replace-per-project semantics.
- Verify fix: §1 PK change.

### R6 — LOW: B3 drill expects the Dev-row verify failure but the xcconfig copy is operator-gated mid-drill

- Location: Stages B3
- Evidence: the drill's honest-failure-then-green sequence depends on the operator copying xcconfigs between steps — fine, but the plan should say the drill PAUSES there (it's a human gate, by the system's own law) rather than implying one continuous run.
- Correction: B3 split: B3a (propose→confirm→revision+verify-fires+honest-failure) automated; B3b (post-copy green re-verify) operator-gated, separately executed.
- Verify fix: B3 text split.

## Questions for the human

None blocking. One optional preference: R3's outcome-note — say so if you'd rather NOT have verdicts written as notes (noise in the knowledge base) and prefer bus-event only.

## Necessary edits to the plan

1. R1: confirmation flip moves to the prepareTurn decoration (identifier-flow mechanism); apply-tool precondition becomes state==='applied'; drop the message-text check and the yaml-parse-as-gate idea
2. R2: dual-layer parking (tool canonical + answer-detector fallback)
3. R3: verify outcome → best-effort durable note (+ optional bus event)
4. R4: DDL for build_config_proposals lives in migrateBuildConfigs
5. R5: PK (session_id, project_id); per-project replace semantics
6. R6: B3 split into B3a automated / B3b operator-gated

## What remains to validate during implementation

The live B3a drill end-to-end; the refusal path with a real unconfirmed session; the prepareTurn flip racing a parallel turn (the identifier-flow's synchronous state claim already covers this — reuse it); note noise levels for R3.
