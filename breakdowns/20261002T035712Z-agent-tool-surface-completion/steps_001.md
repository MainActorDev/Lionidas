# Step 1 — Tier 1: failure-knowledge tools (evidence, triage, versions, flakes)

- **Status:** Ready
- **Plan:** `plans/20261002T035712Z-agent-tool-surface-completion-plan.md` rev 2 (Ready), Stage S1, condition 1; review F1 (evidence lookup modes), F2 (versions full columns)
- **Review:** Ready for implementation (`reviews/20261002T035712Z-…-review.md`)
- **Repo:** `feat/butler-integration` @ `01fa9f7`
- **Depends on:** nothing

## Outcome

4 read tools in `config-tools.ts` (or `tools.ts` where helper-sharing favors it): `evidence.get`, `run.triage.get`, `case.versions`, `flakes.list` — route-faithful, `permission: 'read'`.

## Implementation (grounded shapes)

### evidence.get (F1: two lookup modes)

```ts
// parameters: { evidenceId?: string, runId?: string, stepIdx?: number, inline?: boolean }
// Mode A: evidenceId → SELECT id,bundle_id,type,path,sha256,bytes,created_at FROM evidence WHERE id=?
// Mode B: runId+stepIdx → SELECT evidence_ids_json FROM run_steps WHERE run_id=? AND idx=? →
//         all attached evidence rows (same SELECT … WHERE id IN (…))
// Missing both keys → 'error: evidenceId or runId+stepIdx required'
// Row exists but file gone → 'error: evidence file missing at <path>' (existsSync check)
// inline:true AND type==='screenshot' AND bytes <= 1_048_576 → append base64: readFileSync(path).toString('base64')
//   (video/too-large → descriptor only + note: 'inline skipped (type/size)')
```

### run.triage.get — mirror `GET /api/runs/:id/steps/:idx/triage` (runs.ts:170-182)

Returns the step row + timing split (`evaluated_json.waitMs/workMs`) + joined evidence (`id,type,path,sha256,bytes`); passing step → same shape + `note: 'no failure'` (route returns 200 for any step; step missing → `error: step not found`).

### case.versions — mirror `GET /api/templates/:id/versions` (templates.ts:906) — F2 FULL columns

`SELECT id, revision, steps_sha256, yaml_canonical, scenario_id, scenario_snapshot_json, source, created_by, created_at FROM case_versions WHERE template_id = ? ORDER BY revision DESC` — lookup by id or name (name → resolve to id first).

### flakes.list — mirror `GET /api/flakes` (flakes.ts:8+)

The route composes `flowHistory` + `flakeScore` (module-private in flakes.ts). Mirror = re-query: distinct flow_names → per flow: recent 10 statuses, score, quarantine row (`flow_quarantine WHERE flow_key=? AND released_at IS NULL`). If recomputing flakeScore is non-trivial, EXPORT it from flakes.ts (one-word diff, the established pattern) instead of duplicating the formula — flag in the commit.

## Verification (TDD — extend `test/agent-config-tools.test.ts`)

Seed: a run + failed step with 2 evidence ids (one screenshot file written to tmp, one video row pointing nowhere); a case with 2 versions; a quarantine row.

- evidence.get by id AND by run+step return the same rows; inline returns base64 matching the file; video inline skipped with note; missing file → honest error
- triage.get: failed step shows reason + evidence; passing step shows note; bad idx → error
- versions: full column parity vs a direct SQL probe on the same seed, revision DESC
- flakes: flow listed with score + quarantine reason; empty table → `[]`

```bash
cd server && pnpm vitest run test/agent-config-tools.test.ts && npx tsc --noEmit -p tsconfig.json
```

## Completion gate

- [ ] 4 tools registered, read-class, real schemas; full file suite green; commit pushed
