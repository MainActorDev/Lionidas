# Review — Agentic Infrastructure Core plan

## Rev 3 re-review (2026-10-01) — verdict: **Ready for implementation**

- Plan reviewed: `plans/20261001T035356Z-agentic-infrastructure-core-plan.md` **rev 3** (Ready). Prior: rev 1 → Needs revision (F1–F7); rev 2 → Ready. Rev 3 re-based the plan onto the standalone private repo per brainstorm `20261001T081628Z-agent-core-distribution-orchestration.md` (D13–D17).
- Evidence: plan rev 3 read in full; both brainstorms; npm checks 2026-10-01 (`@modelcontextprotocol/sdk` dep list; `@modelcontextprotocol/fastify` exists — HTTP 200); MCP SDK README (optional per-runtime middleware packages incl. Fastify: "Fastify helpers (app defaults + Host header validation)"); gh auth verified (authenticated account active, org `MainActorDev` reachable, Lionidas repo PRIVATE — repo creation feasible); F1–F7 dispositions traced into rev 3.
- Rev 3 is coherent with D13–D17; prior findings remain addressed. Three NEW non-blocking findings (F8–F10) with minor build-time edits; one low-stakes operator question (Q1).

### Traceability (rev 3)

D13–D17 all land: repo/name/privacy (Stage 0, Rollout) · MCP-only (conditions 6, Stage 4) · demo-not-Lionidas (Objective, Stage 4, out-of-scope, follow-up seed) · seams+anti-forgetting (sessions schema, Stage 2, ROADMAP) · Butler naming (throughout). Conditions 1–8 re-targeted correctly to the demo; F1's draft-lifecycle content correctly relocated to the follow-up seed; F2/F4/F6 mechanics survive the repo move. No contradictions between decisions, conditions, stages, and out-of-scope.

### New findings (repo-move re-audit)

**F8 — LOW/EDIT — MCP-on-Fastify needs the middleware package, not just the SDK**
- Location: Stage 0 deps; Architecture `transport/mcp.ts`.
- Evidence: the SDK's server transports wire via optional per-runtime middleware packages; Fastify wiring is `@modelcontextprotocol/fastify` (registry-verified 2026-10-01), not the base SDK alone.
- Consequence: Stage 4's "mounted in the demo app" hits a missing-package wall mid-build. Minor — a plan-stated dep list.
- Correction: add `@modelcontextprotocol/fastify` to Stage 0 deps. Verify: Stage 0 package.json contains it.

**F9 — LOW/EDIT — one stale Lionidas-ism in the core architecture block**
- Location: Architecture `transport/conversation.ts` — "turn events emitted on the EXISTING WebSocket bus (agent.* event types on /api/events)".
- Evidence: rev 3 moved the demo to its own WS channel (D10 clarified; condition 6 says "`butler_*` event types on the demo's WS endpoint"); this block still names the Lionidas bus + `agent.*` prefix from rev 2.
- Consequence: internal contradiction (condition 6 vs architecture); implementer wires the wrong bus/event names.
- Correction: "turn events emitted on a WebSocket channel provided by the CONSUMER (`butler.*` event types; the core exposes an event emitter — the consumer's bus carries it)". Verify: zero `agent.*`/`/api/events` hits in core sections.

**F10 — LOW/EDIT — edge case names the Lionidas validator, not the demo's**
- Location: Edge & failure cases — "Validator rejects drafted YAML → …".
- Evidence: v1 ground truth is the demo's JSON-schema `spec.validate` (condition 3); "YAML" is the Lionidas variant now in the follow-up seed.
- Consequence: trivial wording, but D15's no-coupling rule should hold in the edge list too.
- Correction: "Validator rejects the drafted spec → one repair round; second rejection surfaces validator errors verbatim." Verify: edge list contains no Lionidas nouns.

### Q1 (operator, low stakes) — CI on the new repo

Stage 0 accepts "GitHub Actions CI (billing caveat — job may not start; local gates authoritative)". Confirmed real from Lionidas PRs #9/#10. Options: (a) accept, local gates authoritative (current text — recommended); (b) skip CI until billing resolves; (c) different token/org. No edit needed if (a).

### Required plan edits (minor, non-blocking; apply at Stage 0)

1. F8: add `@modelcontextprotocol/fastify` to deps.
2. F9: fix conversation-transport wording (consumer WS bus, `butler.*`).
3. F10: de-Lionidas the validator edge case.

### Remains to validate during implementation

Paper review only. Execution must still prove: mock-fixture loop semantics (condition 2); live drill quality (condition 3 — credential-dependent, honestly labeled if mocked); WS turn-event delivery (condition 6); MCP round-trip with a real MCP client (SDK client, not raw fetch); migrations on repeated boots; meaningful eval thresholds (canary guards); clean-clone `pnpm i && pnpm -C demo dev` boot.

---

## Rev 2 review (2026-10-01, superseded by rev 3 re-review above)

- Verdict (rev 2): **Ready for implementation** — all seven rev-1 edits applied; operator decisions F2→WebSocket (D10), F4→official SDK streamable-HTTP (D11), F6 caps→2 MB (D12).

---

## Rev 1 review (2026-10-01, superseded)

- Verdict (rev 1): **Needs revision** — 2 High, 3 Medium, 2 Low; no Critical.

### F1 — HIGH — "draft save returns a draft id, NOT a live template" contradicts the existing lifecycle
- Evidence: `templates.status` CHECK includes `'draft'` (schema.ts:148); duplicate inserts `'draft'` (templates.ts:413); `selectTemplates` filters by status (templates.ts:54). Plan invented a shadow draft store.
- Disposition: rev 2 adopted real-draft lifecycle; rev 3 relocated the content to the Lionidas follow-up seed (v1 has no Lionidas scope).

### F2 — HIGH — SSE asserted on a nonexistent pattern; repo realtime is WebSocket
- Evidence: zero `reply.raw`/`event-stream` in the repo; realtime is `@fastify/websocket` at `/api/events` (events-ws.ts:5-14).
- Disposition: rev 2 → D10 WebSocket; rev 3 → demo carries its own WS channel (Lionidas wiring in follow-up plan).

### F3 — MEDIUM — ESLint boundary lint; no ESLint in repo
- Evidence: root `check` = `pnpm -r check`; no eslint config anywhere.
- Disposition: rev 2 → boundary vitest test; rev 3 → test kept as regression guard (repo structurally has no app to import).

### F4 — MEDIUM — MCP transport + dependency unspecified
- Disposition: rev 2 → D11 official SDK, streamable-HTTP; rev 3 keeps it, demo-mounted (F8 refines the dep list).

### F5 — MEDIUM — provider hang timeout absent
- Disposition: rev 2 → per-call AbortSignal.timeout 120s + `PROVIDER_TIMEOUT` test (condition 2, Stage 1).

### F6 — LOW — blob storage policy unstated
- Disposition: rev 2 → D12 2 MB text cap; binaries to artifacts dir; rev 3 adjusts to consumer-provided dir.

### F7 — LOW — canary could fail on parse, not metric
- Disposition: rev 2 → canary must fail ON THE METRIC ASSERTION (Stage 5).
