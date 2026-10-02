# Step 6 — Live drill + Hermes MCP registration + docs + closeout

- **Status:** Ready
- **Plan:** rev 2, Stage 5; completion conditions 8, 9 (+ repo-gate closeout)
- **Review:** F1 (HTTP-MCP primary), F2 (auth verification + fallback) land HERE
- **Depends on:** Steps 1–5 all gated green

## Outcome and boundaries

The operator tests the integrated agent BY CHATTING THROUGH HERMES (I4): a real session drafts a validating case from a fixture ticket, and the draft lands in the real Lionidas case list. Drill logged; env documented; branch ready for PR. Out of scope: web UI, act autonomy, live Jira.

## Implementation instructions

### 6a. Env + boot
`server/.env` (operator-owned, never committed): `BUTLER_PROVIDER_BASE_URL` (z.ai coding endpoint), `BUTLER_API_KEY`, `BUTLER_MODEL=glm-5.3-flash` — same shape butler's drills used (verified working 2026-10-01). Boot the real server (`pnpm dev` in server/).

### 6b. Hermes MCP registration (F1: HTTP primary)
Add to the operator's Hermes config (`~/.hermes/config.yaml`, `mcp_servers:`):
```yaml
  lionidas:
    url: http://127.0.0.1:9230/mcp
    enabled: true
```
**F2 verification first:** reload Hermes → `tools/list` against the entry. If auth fails (401 — the endpoint is operator-gated and the HTTP client may not send headers):
1. Build the designed fallback `server/src/agent/mcp-stdio.ts`: a stdio wrapper mounting the SAME registry that reads `LIONIDAS_PAT` (a drill PAT minted via the tokens panel) from env and authenticates its in-process calls directly (pattern: butler's `bin/butler-mcp.ts` + the operator's existing atlassian wrapper script).
2. Re-register as a command entry. Record which path survived in the drill log.

### 6c. THE DRILL (with the operator watching or from this session's terminal)
Ask (through Hermes): *"read the DEMO-101 fixture ticket and draft a test case for it"* — expected trace: `sources.search` → `screens.registry` → `case.draft.save` (validator) → repair if needed → VALID → `{templateId, status:'draft'}` → verify in Lionidas: `GET /api/templates` shows the draft; `case yaml <id>` renders; **`case.play` refused** if asked. Log the full trace in `docs/agent-drills.md` (Lionidas convention): endpoint used, hops, tokens, validator rounds, template id, which MCP auth path survived.

### 6d. Docs + closeout
- `docs/agent.md` (Lionidas): what the agent layer is, the tool list with permission classes, env vars, MCP registration for any client, the v1 policy statement (read+draft; act refused), drill log pointer.
- README (server section or root): one paragraph + link.
- Confirm F5 behavior: in a credential-less CI simulation (unset the package? not possible post-install — instead assert the skip contract exists in the test file via a `describe.skipIf(!hasButler)` wrapper pattern where `hasButler = (() => { try { require.resolve('@mainactordev/butler'); return true } catch { return false } })()`).
- Final gates: `pnpm check` (server) + web build + cli suite + `git -C ../butler status` clean.

### 6e. Rollout
Push branch; open PR `feat/butler-integration` → `main` (create-only; operator merges — house rule).

## Verification

- Drill evidence in `docs/agent-drills.md` (trace + ids + auth path)
- `tools/list` from Hermes shows read+draft tools, no act tools
- Draft case visible via existing API/UI surfaces; `status='draft'`
- All repo gates green; butler repo untouched except the Step-1 tag

## Completion gate

- [ ] Hermes→Lionidas MCP working (HTTP or fallback — recorded)
- [ ] operator-driven drill completed and logged (condition 8)
- [ ] live provider used, key only in env (condition 9)
- [ ] docs + README updated; F5 skip wrapper present
- [ ] branch pushed, PR opened
