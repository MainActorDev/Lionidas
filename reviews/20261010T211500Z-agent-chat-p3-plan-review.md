# Review — P3 agent-chat build plan (`20261010T211500Z`)

- Plan reviewed: `plans/20261010T211500Z-agent-chat-p3-plan.md` (commit `38a958e`, as written)
- Evidence: butler `src/transport/conversation.ts` (v0.3.0 as pinned), lionidas `server/src/agent/routes.ts`, `server/src/agent/pipeline-routes.ts`, `server/src/ws/bus.ts`, `web/src/router.ts` — all read 2026-10-10
- Verdict: **Needs revision** — one High (duplicate server surface), two Mediums (contradictory binding mechanism; executor pill has no data source), one Low (vague run trigger)

## Findings

### F1 — HIGH · C2 duplicates endpoints that already exist
- **Location**: plan C2 ("Server: `GET /api/agent/conversations` + `GET /api/agent/conversations/:id/messages` … new route file")
- **Evidence**: butler's `registerConversationApi` (mounted in lionidas `routes.ts:18`, operator-gated) already exposes `GET /api/agent/sessions` (list), `GET /api/agent/sessions/:id` (returns `{ session, messages }`), `POST /api/agent/sessions` (create with title), `POST /api/agent/sessions/:id/messages` (turn).
- **Consequence**: building parallel "conversation" routes adds a second surface for the same data, splits maintenance, and the plan's claim "no server core changes beyond it" is wrong in the expensive direction — the work is unnecessary, not merely new.
- **Correction**: delete C2's server work entirely; the web sidebar/thread consume the existing `sessions` endpoints. Server delta for P3 = zero new routes.
- **Verify**: plan C2 references only `/api/agent/sessions*`; `server/src/agent/conversation-routes.ts` absent from the architecture block.

### F2 — MEDIUM · conversation↔run binding contradicts itself
- **Location**: C5 ("client-side map in P3: `conversation.pipelineRunId` stored on the conversation's metadata note; server-side binding deferred")
- **Evidence**: "client-side map" and "stored on the conversation's metadata note" are different mechanisms — butler sessions carry only `title`/`user_id` (contract.ts `SessionRow`); there is no metadata field, and writing a note per conversation pollutes the notes layer the planner reads.
- **Consequence**: implementer must invent the mechanism mid-build; the note variant leaks UI state into agent memory (the planner would see it).
- **Correction**: one mechanism, stated: **localStorage map `agentRunBySession: { [sessionId]: runId }`**, and the run panel accepts a runId (also deep-linkable via `?run=`).
- **Verify**: C5 names only localStorage; no mention of notes for binding.

### F3 — MEDIUM · executor pill has no data source
- **Location**: C3 ("executor pill (from `/api/agent/capabilities`-style env config …)")
- **Evidence**: no endpoint exposes executor configuration (grep over server/src — nothing serves it); the phrase "-style" papers over a missing API.
- **Consequence**: the pill renders fiction, or S3 grows a config endpoint the plan never scoped.
- **Correction**: **defer the pill to P5** (when claude-cli lands and a config surface is actually designed). P3's composer shows refs + send only — matching every drill interaction that mattered.
- **Verify**: C3 has no executor pill; out-of-scope list gains "executor picker (P5)".

### F4 — LOW · run-start trigger is a heuristic
- **Location**: C5 ("the message mentioning drafting (or an explicit `/pipeline` prefix)")
- **Evidence**: "mentioning drafting" is string-guessing the user's intent.
- **Consequence**: nondeterministic UX — sometimes a chat reply, sometimes a pipeline.
- **Correction**: deterministic rule: **refs attached ⇒ the send starts a pipeline** (and posts the chat turn); no refs ⇒ chat only. No text parsing.
- **Verify**: C5 states the rule as such.

### F5 — LOW · direct-URL access by viewer/anonymous unhandled
- **Location**: C1 (nav gating) — but nothing about route-level
- **Evidence**: nav hiding ≠ route protection; the server will 401/403 the underlying calls but the page would render empty.
- **Correction**: edge case added — `/agent` with a non-operator `me` shows the "operator role required" state (same pattern as UsersPage directory).
- **Verify**: edge-cases list contains it; C7 covers a viewer-mount test.

## Coverage notes

- Traced W1–W5 → C1–C8: layout, palette scoping, typography, question/answer flow (answer+resume endpoints verified in `pipeline-routes.ts`), collapse persistence — all grounded.
- `agent.workflow` events exist on the bus (bus.ts:7) — the events-driven panel is real, not aspirational.
- Verified on paper: data contracts, event wiring, stage ordering, auth gates. Needs execution: the C8 live drill (event-driven stage updates without reload), contrast assertions in tests, WS-drop polling fallback.

## Necessary plan edits

F1 (delete server routes, re-point C2/S2), F2 (localStorage-only binding + `?run=` link), F3 (drop the pill, out-of-scope entry), F4 (deterministic refs⇒pipeline rule), F5 (viewer route state + test). All five are localized to C2/C3/C5, the architecture block, S2, and the edge-case list.
