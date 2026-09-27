# Phase E — Case Status Lifecycle

> **For Hermes:** per-phase cycle from the master plan — plan → self-review →
> HUMAN GATE → implement task-by-task with per-task verify + commit. UI task
> gated on a sketch pick (≥3 variants, user picks, then 1:1 build).
> Source: `docs/plans/2026-09-18-testcase-management.md` §Phase E
> (line 216) + DEFERRED.md §G. This is the FINAL phase of the
> test-case-management arc (A versions → B variants → C runner → D suites → E lifecycle).

**Goal:** Give cases a `draft / active / deprecated` lifecycle; batches exclude
`deprecated` by default; chips + actions in the UI; guide + DEFERRED close-out.
After E the arc is complete.

**Architecture:** One guarded ALTER (`templates.status`, default `'active'`,
API-layer validation — SQLite ALTERs can't add CHECKs, house pattern), one
selection-seam change (`selectTemplates` + the suite-play drift filter), one
PATCH field, UI chips/actions, docs. No new tables, no runner changes.

**Tech Stack:** SQLite migration in `migrateM1` guarded block, vitest
(server 845 baseline), Vue/Axiom for chips.

---

## Decisions (made in this plan — veto at the gate)

1. **`draft` runs everywhere; only `deprecated` is excluded.** The master plan
   says "play-all default excludes deprecated" — nothing about draft. A draft
   is unfinished but runnable (recorder loops). Semantics:
   - single `/play` → **always allowed**, any status (manual intent wins)
   - play-all / plans / suite play → `deprecated` excluded/skipped **with a
     named reason** (suite play mirrors the bundle-drift skip), `draft` included
2. **Default status `'active'`** — every existing case (and legacy row) reads
   active; no backfill migration needed.
3. **Status is NOT a YAML key.** It's case metadata (like tags? no — tags are
   YAML). Status lives on the templates row only, set from the UI/route. YAML
   stays execution semantics. (Rejecting `status:` in YAML keeps one source of
   truth; the parser's unknown-key guard already errors on it inside steps, and
   top-level unknown keys stay silently ignored per DEFERRED §H — unchanged.)
4. **No CHECK constraint in DB** — validation at the PATCH seam only, exactly
   like bundle enforcement (API level, SQLite/compat pattern).

---

## Tasks

### T1 — Migration: `templates.status` column

**Files:** `server/src/db/schema.ts` (guarded ALTER block, ~line 242 area)

Add to the M3 guarded ALTERs list:

```ts
'ALTER TABLE templates ADD COLUMN status TEXT',
```

plus, right after the list, the default backfill (guarded, idempotent):

```ts
// Phase E: status lifecycle — legacy rows must READ active, not NULL.
// ALTER DEFAULT only covers new inserts; normalize once, guarded.
try { db.prepare("UPDATE templates SET status = 'active' WHERE status IS NULL").run(); } catch { /* fresh DB: table has CHECK-era default below */ }
```

And in the CREATE TABLE for `templates` (fresh DBs), add the column with the
CHECK + default (fresh tables CAN carry CHECKs):

```sql
status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('draft','active','deprecated')),
```

**Test** (`server/test/schema-status.test.ts`, new):
- fresh DB → every templates row reads `status='active'` without any write
- legacy simulation: build fresh DB, `UPDATE templates SET status=NULL`,
  re-run migrate → all `'active'`
- guarded ALTER idempotent: migrate twice, no error

**Verify:** `CI=true npx vitest run schema-status --maxWorkers=2` → green.
**Commit:** `feat(schema): templates.status lifecycle column (guarded ALTER + backfill)`

### T2 — API seam: read + PATCH validation

**Files:**
- `server/src/routes/templates.ts` — `TemplateRow` (add `status: string | null`),
  `rowToTemplate` (emit `status: r.status ?? 'active'`), `PATCH /api/templates/:id`
  body type + validation + UPDATE column.

PATCH guard (before the UPDATE):

```ts
if (b.status !== undefined && !['draft', 'active', 'deprecated'].includes(b.status)) {
  return reply.code(400).send({ error: 'status must be draft|active|deprecated' });
}
```

UPDATE gains `status = ?` with `b.status !== undefined ? b.status : (row.status ?? 'active')`.

**Tests** (extend `server/test/templates-status.test.ts`, new):
- PATCH `{status:'deprecated'}` → row reads deprecated; `updated_by` stamped
- PATCH `{status:'bogus'}` → 400; PATCH without status → untouched
- GET list emits `status` for legacy row (seed NULL manually → reads `'active'`)

**Verify:** targeted vitest green; `npx tsc --noEmit` clean.
**Commit:** `feat(api): case status read/write — PATCH validation + legacy normalize`

### T3 — Selection seams: batches exclude deprecated

**Files:**
- `server/src/routes/templates.ts` — `selectTemplates` (line 46): TWO knobs,
  not one (calling them out because a single `status` filter cannot express
  both needs — the chips' "all" view must SHOW deprecated while play-all must
  HIDE them; a default-exclusion would make "all" impossible):

```ts
// exact match when set; never excludes anything by itself
status?: 'draft' | 'active' | 'deprecated';
// batch safety default is explicit at the CALLER (explicit > silent):
// play-all/plans pass true, the list route passes per-chip
excludeDeprecated?: boolean;
```

body:

```ts
const st = (r.status ?? 'active');
if (filter.status !== undefined && st !== filter.status) return false;
if (filter.excludeDeprecated === true && st === 'deprecated') return false;
// tags + app checks unchanged
```

- `server/src/routes/manual.ts` `runBatch` (line 580): row query is
  `SELECT *` so `status` rides along at runtime; the local cast
  (`Array<{id, app_bundle_id, tags_json}> as never`) is a type lie only —
  no change. The call gains `excludeDeprecated: true`. The `b.cases` path
  (suites, line 574) does NOT filter — the suite-play route owns members.
- `server/src/routes/manual.ts` suite play (line 802, `inScope` filter ~815):
  join status into the prepared stmt and skip deprecated members beside
  bundle drift. **The all-skipped 409 branch (line ~832) must learn the new
  case:** today its ternary renders "every member has only dead variant pins"
  when `drifted` is empty — an all-deprecated suite would surface that WRONG
  message. Add a third branch + code `DEPRECATED`:

```ts
const tplState = db.prepare('SELECT app_bundle_id AS b, status AS st FROM templates WHERE id = ?');
// in inScope: if (st === 'deprecated') { deprecatedSkipped.push(m.templateId); return false; }
// allSkipped message: deprecated-only → `every member is deprecated: ${deprecatedSkipped.join(', ')}`
// 200 response gains ...(deprecatedSkipped.length ? { skippedDeprecated: deprecatedSkipped } : {})
```

**Tests:**
- play-all (`excludeDeprecated: true`): seed active + draft + deprecated →
  batch selects active+draft only
- suite play: deprecated member skipped with `skippedDeprecated` in response,
  others run; ALL members deprecated → 409 `DEPRECATED` with the right message
  (regression: the old code would have said "dead variant pins")
- single `/play` on a deprecated template → still 200 (manual intent wins)
- exact `filter.status='deprecated'` → only deprecated (the chips use this);
  `excludeDeprecated` unset + no status → NOTHING excluded (list/"all" view)

**Verify:** targeted vitest; full `CI=true npx vitest run --maxWorkers=2` → 845+ green.
**Commit:** `feat(batch): deprecated cases excluded from play-all/suites with named skip`

### T4 — Web: status chips + deprecate/restore — ⚠ SKETCH-GATED

**Gate:** 3 sketch variants first (NEW FILES under `sketches/013-status-lifecycle/`,
real Axiom tokens, content-sized, whole-page state incl. chrome), user picks,
then 1:1 VERBATIM build. Concepts the variants must explore:
- filter-row chips: `all · active · draft · deprecated` with counts (beside
  existing tag chips) — or a single status dropdown; deprecated count badge
- row affordance: kebab menu vs inline `deprecate`/`restore` button vs
  row-context action — deprecated rows visually dimmed with a `deprecated` pill
- empty state when a status filter hides everything

**Files after pick:**
- `web/src/pages/TestCasesPage.vue` — chips state (`statusFilter` ref), fetch
  passes `?status=`, row action → `PATCH {status}` → optimistic update, dimmed
  row styling for deprecated
- `server/src/routes/templates.ts` list route (line 131, verified):
  `const q = req.query as { ticket?: string; tags?: string; app?: string; status?: string }`
  and the call becomes `selectTemplates(rows, { tags: q.tags, app: q.app,
  ...(q.status ? { status: q.status as 'draft'|'active'|'deprecated' } : {}) })`
  — the LIST route never sets `excludeDeprecated` (chips' "all" shows everything;
  each chip is an exact match; play-all sets the batch knob, not the list).

**Tests:** existing web suite (vue-tsc + build) green; chip filtering is
server-tested in T3 — UI is wiring only. Live-verify chips in the drill (T6).
**Commit:** `feat(web): status chips + deprecate/restore (013-A) 1:1`

### T5 — Guide + DEFERRED close-out

**Files:**
- `web/src/pages/GuidePage.vue` — short "Case lifecycle" section: what each
  status means, that play-all/suites skip deprecated with a reason, single
  play still allowed, how to restore. Plain-EN, minimal (house voice).
- `docs/plans/2026-09-18-testcase-management.md` — Phase E line gets
  `✅ SHIPPED <commit>` marker.
- `DEFERRED.md` §G — Phase E entry updated to SHIPPED; evidence-retention
  decision stays OPEN (product call, surfaced at the gate); publish act stays
  rejected-for-v1 (revisit on demand). No other entries change.

**Commit:** `docs(guide+deferred): phase E lifecycle section, arc close-out`

### T6 — Gates + live drill + final commit

**Gates:** `CI=true npx vitest run --maxWorkers=2` (server), `npx tsc --noEmit`,
`npx vue-tsc --noEmit` + `CI=true pnpm build` (web).

**Live drill (receipts in the commit message):**
1. deprecate `intl drill` via PATCH → templates page shows dimmed row + chip
2. play-all with its tag → response lists it skipped/deprecated (or absent)
3. suite containing it → play response carries the named skip
4. single play still runs (lane chip opens — dock fix holds)
5. restore → play-all includes it again

**Commit:** `docs: phase E shipped — status lifecycle live-drill receipts`

---

## Optional add-on (decide at the gate — separate commit either way)

**T7 — Forge pre-flight for scenario runs.** Today a `networkScenario` run with
mitm/routing down fails as `not found: <text>` after full playback — three
manually-armed switches (sim boot, mitm, routing), zero pre-flight. Fix:
before lane start, if the resolved case uses a scenario, check
`mitmRunning()` + `simRoutingState().enabled` → fail fast (400 at play time /
`failed` with reason `scenario inactive: start forge proxy + routing`).
~30 lines + tests. NOT part of phase E scope — today's morning incident is the
trigger, but it's a runner change wearing a lifecycle hat. Include or park in
DEFERRED §F-adjacent? **Park by default** unless you say otherwise.

---

## Risks / notes

- `SELECT *` callers that destructure templates rows are unaffected (new
  column is additive); grep confirmed only `selectTemplates` filters.
- Suite-play drift skip shape (`skipped: string[]` in response) already
  exists — deprecated joins it, no wire change for the board.
- Chips must not lie about counts (visible-set semantics like play-all's
  "play what you see") — counts come from the server per filter, not client math.
- Evidence-retention decision (DEFERRED §G) remains the arc's one open
  product call — surfaced at the gate, not silently decided here.
