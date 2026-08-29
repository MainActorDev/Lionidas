# M3 — Cockpit: Manual Drive, Flakes, Jira, Forge Advanced (Crucible Phase 3)

**Status: READY — no build until approved.** · Parent: [../PLAN.md](../PLAN.md)
Prereq: M2 gate green (queue, A1–A3, Forge core) · Duration: 2–3 days

## 0. Scope

The dashboard becomes a cockpit: QA can drive a device by hand (clearly labeled,
never counted), flaky flows are surfaced and quarantined, evidence lands on Jira
tickets opt-in, and Forge gains failure injection UX + match tester + rehearse +
the MITM decision gate.

## 1. Manual drive mode

### 1.1 Session lifecycle

```
POST /api/manual/start { udid, operator }   → 202 {sessionId}
  pre: device free (queue head for it is drained/paused) — else 409 QUEUE_ACTIVE
  effect: enqueue manual run (priority 0) whose "flow" IS the manual session:
    alloy_apps open → lease held by 'manual:<sessionId>' → WS manual.session.open
POST /api/manual/:id/tap     { x, y }        → alloy_act {target:{x,y}}   (A2)
POST /api/manual/:id/scroll  { direction }   → alloy_act scroll
POST /api/manual/:id/snapshot               → alloy_snapshot; WS frame to operators
POST /api/manual/:id/finish { note? }        → alloy_release; run finished
  crash-safety: orphaned manual leases auto-finish after 5min idle (poller)
```

Manual session = a `runs` row (kind `manual`, status running) so wall + history
stay truthful. **Roll-up exclusion is structural**: `deriveAcStatus` reads only
kind `automated|rerun` rows (assert in tests); UI labels manual everywhere
(badge on tile, row, run header).

### 1.2 Web — DrivePage

Tile → **Take control** → DrivePage: live snapshot canvas (tap maps to
normalized coords → x/y px via device logical size), direction pad, refresh
snapshot, note field, finish. Multi-observer: other clients see
`manual.session.*` events + snapshot frames; only the operator holds the lease.
Every tap is traffic-logged as manual evidence (screenshots on a ring buffer of
last 20; final bundle attached to the manual run row).

## 2. Flake analytics + quarantine

```
src/domain/flake.ts    # NEW in M3 (no M1 stub): flakeOf(flow): alternation rate last 10
src/routes/flakes.ts   # GET /api/flakes?ticket=
src/routes/quarantine.ts # POST /api/flows/:key/quarantine { reason, by }
                         # DELETE .../quarantine (un-quarantine, reason required)
```

Rules (normative): alternation = adjacent run results differ (pass↔fail|error);
flake score = alternations/9 over last 10; **auto-quarantine** when ≥3
alternations within 7 days → `flows.quarantined_until = NULL` (manual-only
release) + WS event + "attention" strip on MatrixPage. Quarantined flows: gray
cells, excluded from roll-up (status module change + tests), listed with reason
+ last evidence. Quarantine decisions are rows (who/when/why) — auditable.

Table: `flow_quarantine(flow_key PK, reason, by, at, released_by, released_at)`.

## 3. Jira evidence attachment (opt-in)

```
src/integrations/jira.ts   # thin client (env JIRA_BASE/EMAIL/TOKEN; off unless set)
POST /api/runs/:id/attach   # 404 if integration disabled
```

Comment body: ticket summary line, run link (CRUCIBLE_URL), status per AC,
artifact hash + freshness, scenario name+sha (if any), and evidence LINKS (video,
worst-diff screenshot) to orchestrator routes — links, not inline media (Jira
renders URLs; viewers need LAN reach to the orchestrator). Scope:
**comment-only** — no transitions, no field writes (open decision #5 default).
Retry ×2 on network failure; comment id recorded on the run row.

## 4. Forge advanced

### 4.1 Failure injection UX

Preset editor gains failure tab: timeout / reset / malformed / throttle +
**sequence builder** (rows: status/body/delay; drag order; "last repeats"
toggle). MatrixPage filter: AC category `network-failure` → suggests relevant
failure presets (by tag on preset: `tags: ['retry','timeout']`).

### 4.2 Match tester + rehearse

- **Match tester** (preset editor): paste method+URL+headers → response shows
  WHICH preset wins among the scenario and WHY (match kind, path score, guard
  results) — same `matcher.ts` code, no second implementation.
- **Rehearse** (scenario builder): pick a smoke flow + device → runs one flow
  against the active scenario (priority manual, labeled rehearse run kind
  `automated` note='rehearse', does NOT roll up — rehearse flag on run row;
  assert exclusion in tests) → toast result + traffic summary.

### 4.3 MITM gate (decision, not default work)

Spike task (timeboxed 3h): script CA gen + simulator trust + one HTTPS staging
endpoint through proxy. Outcome recorded in this file's addendum: **GO** (spec
follow-up phase M4-forge-tls) or **NO-GO** (documented blocker). Nothing ships
to users from the spike.

## 5. Tests (named)

| File | Asserts |
|---|---|
| `test/manual.session.test.ts` | 409 when queue active; lease held 'manual:'; taps → A2 point calls; finish releases; idle auto-finish; roll-up exclusion |
| `test/flakes.calc.test.ts` | alternation math; auto-quarantine at ≥3/7d; release requires reason |
| `test/quarantine.rollup.test.ts` | quarantined flow gray + excluded; decision rows written |
| `test/jira.comment.test.ts` | comment body shape (fixture snapshot); disabled → 404; retry; run row records comment id |
| `test/forge.tester.test.ts` | match tester uses production matcher (same outcomes incl. guards + longest-path) |
| `test/forge.rehearse.test.ts` | rehearse run created, labeled, excluded from roll-up |
| `test/forge.failinject.test.ts` | timeout/reset/malformed behaviors over a live socket (unit-level proxy) |

## 6. GATE (live)

```bash
pnpm check
#  G1 manual session from UI: Take control → taps land on device (Settings scroll
#     observable), tile shows MANUAL badge, matrix UNCHANGED
#  G2 second browser tab sees the manual session live (observer)
#  G3 queue waits during manual; resumes after finish
#  G4 flaky fixture (pass,fail,pass,fail... seeded history) → attention strip +
#     auto-quarantine; un-quarantine with reason; matrix gray → normal
#  G5 attach-to-Jira on staging ticket → comment visible w/ links + hashes
#  G6 match tester: 3-overlap URL resolves to longest-path preset with reason
#  G7 rehearse scenario: smoke flow runs labeled rehearse, excluded from matrix
#  G8 failure sequence 200→500: app retry observed; AC network-failure passes
#  G9 MITM spike outcome recorded (GO spec or NO-GO doc) — no half-shipped TLS
```

G1–G9 observed = project complete per current scope. Session screenshots +
Jira comment link attached to completion message.

Commit: `feat(m3): cockpit — manual drive, flakes, jira, forge advanced`.

## 7. Post-M3 (parking lot, not commitments)

CI replay lane (`.ad` scripts from wall), multi-device parallel run fan-out,
release-train rollups, Forge TLS (if GO), RBAC for approvals, artifact registry
integration.
