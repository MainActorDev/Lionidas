# Agent Drills

Live integration drills for the Butler-powered agent layer (plan
`20261001T155936Z`, breakdown steps_006). Each drill records: endpoint,
model, hops/tokens, validator rounds, artifacts, and which MCP auth path
survived.

## 2026-10-02 — Condition 8+9: live authoring drill (glm-5.3-flash via z.ai)

- **Surface:** HTTP conversation API (`/api/agent/sessions/:id/messages`),
  PAT auth (`lion_…` drill token, operator role, minted in-process).
- **Provider:** `BUTLER_PROVIDER_BASE_URL=https://api.z.ai/api/coding/paas/v4`,
  `BUTLER_MODEL=glm-5.3-flash` (key in `server/.env`, gitignored — never in
  code or logs).
- **Prompt:** "Read ticket LP-1042 from your sources, then draft a test case
  for it. Follow your rules…"

### Turn 1 — honest refusal (the interesting one)
- 5 hops, 14,402 in / 3,871 out tokens, ~91 s.
- Trace: `sources.search` → ticket found (LP-1042 checkout crash) →
  `screens.registry` for `com.lionparcel.consumer` → `case.draft.save` →
  **validator refused**: `unknown screen "checkout-summary" — declare it in
  the app registry` → agent **saved nothing**, wrote provenance-stamped
  env-gate note `note_5e604047-d07`, and told the operator the exact unblock
  (register the two screens; also flagged that existing consumer cases run
  under the `int-dev` bundle — worth confirming the target).

### Unblock (operator side)
- `PUT /api/apps/com.lionparcel.consumer/screens` registering
  `checkout-summary` (state `settled`) + `payment-web` (state `loading`)
  — revision 2.

### Turn 2 — repair and save (same session, resumed from rows)
- 5 hops, 12,788 in / 2,524 out tokens, ~67 s.
- The agent re-drafted, hit ONE validator iteration (`entry` must be an
  object → `{screen: checkout-summary, mode: navigate}`), saved a
  **convention note** about it, then:
- **`tpl_9f496e4d`** "LP-1042 pay now settles before payment web (iPad)",
  `status='draft'`, 3 narrated steps (`expect screen: checkout-summary.settled`
  → `tap: { on: Pay Now }` → `expect screen: payment-web.loading`).
- Verified through the REAL API: `GET /api/templates` shows the draft;
  `GET /api/templates/tpl_9f496e4d/yaml` renders valid case yaml.

### Act-class refusal (live)
- MCP `tools/call case.play` → `Tool case.play not found` (act tools are
  invisible under the v1 policy — not merely blocked).

## MCP auth path (F2 verdict)

- **HTTP `/mcp`**: operator-gated; works with `Authorization: Bearer lion_…`
  (verified: initialize → tools/list → tools/call round-trip, 12 tools, no
  act tools). Hermes's `url:` config form has no header field, so:
- **Survivor: the stdio wrapper** `server/src/agent/mcp-stdio.sh` →
  `src/agent/mcp-stdio.ts`. It loads the SAME registry in-process against
  the same `crucible.db`, resolves the operator from `LIONIDAS_PAT` env,
  sources `server/.env` for provider env, and speaks stdio MCP. Registered
  in `~/.hermes/config.yaml` as `mcp_servers.lionidas`. Smoke-verified:
  initialize + tools/list → 12 tools, act tools absent.

## Reproduce

```bash
cd server && pnpm dev            # BUTLER_* env from .env
# mint a PAT (Users → api tokens in the web UI, or in-process)
LIONIDAS_PAT=lion_… bash src/agent/mcp-stdio.sh   # stdio MCP for Hermes
```

## 2026-10-02 — Config-author drill (plan 20261001T181820Z, condition 8)

- **Surface:** conversation API, PAT auth; live glm-5.3-flash; 26 tools
  (12 case-layer + 14 config-author).
- **Prompt:** create scenario `lp1042-payment-error` (preset POST
  /v2/payments/authorize → 502) → suite `Checkout regression` with the
  LP-1042 draft → revise the case to expect payment-web.loading "if it
  does not already".
- **Trace (3 hops, 13,350 in / 3,398 out, ~73 s):**
  `preset.draft.save` → `scenario.draft.save` (`s_5327abce`, created_by
  agent) → `suite.draft.save` (`suite_caf0ecfd`, bundle scope correctly
  derived from the member → com.lionparcel.consumer) → case read →
  **honest skip**: the draft already ends with
  `expect screen: payment-web.loading`, so the revise condition wasn't
  met — the live case was left untouched (exactly the guarded behavior
  steps_004 built; the drill caught the agent APPLYING the guard, not
  just the tests).
- **Verified through the real API:** scenario GET shows members join
  (preset `p_f62ac496` POST 502, enabled); suite GET shows member
  tpl_9f496e4d under the right bundle; presets synced (syncPresets
  counter path).
- **Agent also volunteered** the next step it CANNOT do alone: wiring
  the scenario as a variant of the case would need a draft revision —
  it asked instead of acting beyond the prompt.
- **Instructions smoke:** MCP initialize carries the config-author
  section (4,145 chars; probes: Config authoring / single-app /
  IMMUTABLE / case.draft.revise / Humans do the rest — all present).
