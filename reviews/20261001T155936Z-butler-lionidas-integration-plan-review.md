# Review — Butler→Lionidas integration plan

- Plan reviewed: `plans/20261001T155936Z-butler-lionidas-integration-plan.md` (Ready, 2026-10-01, single version)
- Evidence sources: the plan; source brainstorm `brainstorm/20261001T155936Z-butler-lionidas-integration-scope.md` (all answers verified recorded); Butler repo state verified live 2026-10-01 — **feasibility probe executed, not just read**: `@mainactordev/butler` installed into Lionidas server via `file:` link (`pnpm add` rc=0, +112 pkgs), imported under Lionidas's own tsx (`ToolRegistry`/`DRAFT` load, `butler loads under Lionidas tsx: true draft`), and exercised inside Lionidas's vitest (`SqliteStorage.memory()` round-trip: 1 passed). Export surface checked via tsx: all 16 symbols the plan's `routes.ts`/`tools.ts` will import are present. Also verified: `renderTemplateYaml` is module-private (templates.ts:162 — plan cites the route, correct); Lionidas server runs `tsx watch src/main.ts` (TS-source deps resolvable); dep versions Lionidas-side (fastify 5.12.1, ws 8.21.3, better-sqlite3 11.10.0 vs butler's 12.x — see F3); butler had one uncommitted tracked change (bin mode flip), now committed/pushed (`7db8fcd` on the branch; merge PR already at `4c6ebb2`).
- Verdict: **Ready for implementation** (plan rev 2: F1–F5 edits applied by the reviewer in the same pass — HTTP-MCP primary, Hermes-auth fallback, sqlite-split disclosure, verbatim 409s, honest CI skips). No Critical/High findings. 3 Medium findings (one feasibility caveat confirmed real but non-blocking with a stated mitigation), 2 Low. Findings F1/F2 fold into plan edits; F3 is a disclosed risk with a designed check.

## Traceability

I1–I7 trace to verified operator answers in the brainstorm (direction reversal, merge/pin, Jira deferral, Hermes-as-client, draft-policy discipline, storage/event seams, auth reuse). Conditions 1–9 map to stages 0–5 (C1→0, C2→1/2, C3→2, C4–6→3, C7→4, C8–9→5). Out-of-scope matches the scope doc. The F1-carryover (real draft templates, no shadow store) is correctly embedded in Stage 2 and condition 3. No extra commitments beyond the scope doc found.

## Findings

### F1 — MEDIUM/EDIT — Stage 5 MCP-client choice for Hermes needs a decision rule, not a either/or
- **Location:** Stage 5 ("stdio or HTTP per what the mounted endpoint supports").
- **Evidence:** Butler ships BOTH: streamable-HTTP mounted at `/mcp` (verified in butler's stage-4 tests) and a stdio bin (`bin/butler-mcp.ts`, SDK-client-proven). Hermes's config supports both shapes (operator config inspected: `mcp_servers:` with command and url entries).
- **Consequence:** minor — but the plan should pin the primary, not defer: the HTTP mount is the one that runs INSIDE the booted Lionidas server (auth-adjacent, no extra process), while the stdio bin as-shipped serves the DEMO registry, not Lionidas tools — using it would require a Lionidas-specific bin wrapper.
- **Correction:** Stage 5 primary = the mounted HTTP endpoint (`url: http://127.0.0.1:9230/mcp` style entry in Hermes config); stdio bin stays a Butler demo artifact, not this integration's path. Note the auth implication below (F2).
- **Verify:** Stage 5 text names the HTTP endpoint as primary.

### F2 — MEDIUM/EDIT — The MCP endpoint behind the operator gate needs a token path Hermes can actually send
- **Location:** Stage 3 (auth) + Stage 5 (drill).
- **Evidence:** the plan gates `/api/agent/*` AND `/mcp` behind the existing hook (session cookie / PAT bearer). Hermes's MCP client config (inspected) carries `command`/`args`/`url` — env-passing exists for stdio wrappers; whether the HTTP MCP client sends an `Authorization` header is a Hermes-client capability question the plan hasn't verified.
- **Consequence:** the drill could stall on a 401 the Hermes client can't produce headers for.
- **Correction:** Stage 3 adds: verify the Hermes MCP HTTP client's auth-header support; fallback designed in advance — a tiny localhost stdio wrapper (`server/src/agent/mcp-stdio.ts`) that mounts the SAME registry and injects the PAT from env (pattern: butler's bin + the atlassian wrapper already in the operator's config). Drill proceeds via whichever path authenticates.
- **Verify:** Stage 3/5 text carries the fallback; the drill log records which path was used.

### F3 — MEDIUM/DISCLOSED — better-sqlite3 major-version split (Lionidas 11.10.0 vs Butler 12.x) in one process
- **Location:** Stage 0/1 (dependency + storage).
- **Evidence:** Lionidas server pins better-sqlite3@11.10.0; Butler declares ^12. The `file:` probe loaded butler with its own nested copy under pnpm isolation and the vitest probe passed — two native modules coexist today. Risk is drift/ABI surprises on future upgrades (not a current failure).
- **Consequence:** low now; a future `pnpm up` on either side could silently flip which native binding butler binds.
- **Correction (disclosure + guard, not a code change now):** plan notes the split; Stage 1's migration guard test doubles as the canary (if butler's driver ever misbinds, it fails there first). Optional later: align majors across repos.
- **Verify:** plan edge-case list mentions the version split.

### F4 — LOW/EDIT — `case.draft.edit` on a case whose app changed needs the folder-scope guard surfaced
- **Location:** Stage 2.
- **Evidence:** Lionidas templates PATCH refuses app changes while foldered (templates.ts ~:520) and the yaml PUT enforces ref resolution — the tool should return those 409 semantics verbatim rather than wrapping them.
- **Consequence:** minor UX in error paths; the plan already says validator errors verbatim, just extend the same rule to these guards.
- **Verify:** Stage 2 wording.

### F5 — LOW/EDIT — CI without the private-repo credential must skip honestly
- **Location:** Rollout; Stage 0.
- **Evidence:** GitHub Actions on Lionidas already has the billing/job-start problem; a private git-pin additionally needs deploy-key auth in CI. The plan's edge list mentions vendored checkout; make the honest-skip explicit: tests requiring `@mainactordev/butler` are skipped (not failed) when the package is absent, and the skip is counted in output.
- **Verify:** edge-case list updated.

## Human questions

None blocking. (F1's primary-path choice and F2's fallback are engineering calls within the operator's stated "use Hermes" decision; both recorded as plan edits, not questions.)

## Required plan edits (minor, non-blocking)

1. F1: Stage 5 names the mounted HTTP MCP endpoint as the primary Hermes path.
2. F2: Stage 3 adds the Hermes-MCP auth verification + stdio-wrapper-with-PAT fallback.
3. F3: edge list discloses the better-sqlite3 major split + names the migration guard as its canary.
4. F4: Stage 2 extends "errors verbatim" to folder/app-scope 409s.
5. F5: honest-skip semantics for butler-dependent tests in credential-less CI.

## What remains to validate during implementation

Paper + probe review only (the probe DID execute the install/import/vitest path — stronger than paper, still not the full build). Execution must still prove: the github: pin (vs file:) incl. CI auth; operator-gated `/mcp` with a real PAT; the note-injection assertion against persisted provider rows in the Lionidas app; `agent.turn.*` events through the real `/api/events` WS; the Hermes drill end-to-end (condition 8) — including which auth path survived; the eval port passing with the mock provider in Lionidas CI; and no regressions in the existing 1138-test server suite.
