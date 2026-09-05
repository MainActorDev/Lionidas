# Playback Evidence Policy — video for template runs + latest-only retention

> **For Hermes:** TDD, small batches, commit per task. Live drill at the end.
> **User goals (2026-09-05):** (1) store screenshots/videos ONLY for template/playback runs —
> manual/watch store nothing; (2) a new run of a template REPLACES the previous run's
> artifacts (latest-only, per template); (3) playback gets video like the automated path.

## Design

**Video on playback** — mirror the automated runner's proven pattern (`alloy/runner.ts:165-269`):

- Run-start (after the settle gate, before step 1): `alloy_video {action:'start'}` — best-effort,
  `.catch(() => null)`; a video failure never blocks the run.
- Run-finish (in the existing `finally`, alongside the final screenshot):
  `alloy_video {action:'stop', label: runId}` → `video.hostPath` → `ingestEvidence(type:'video')`.
- Template playback uses engine-B for video via the same `alloy.dispatch` seam — per-call
  lease, no interaction with the A-side app session.
- Evidence link: attach the video id to every step row? NO — playback's step rows write
  `evidence_ids_json` at insert time (before the video exists). The final screenshot keeps
  its current `runs.artifact_path` role; the video is linked via its own evidence row +
  a new `runs.video_path` column (simple, queryable, matches `artifact_path`).

**Latest-only retention** — replace on new run of the same template:

- At playback start (before steps execute): find the previous run of the SAME template id
  (`SELECT id FROM runs WHERE kind='template' AND note LIKE ...` — no; runs table carries
  `triggered_by`/template? VERIFY: runs table columns — `triggered_by` holds
  `template:tpl_xxx` per the note prefix seen in drills). Cleaner: add `template_id` column?
  The note already carries `template:{id} {name}` and `runTemplatePlayback` owns the insert —
  add a real `runs.template_id` column (migration, backfill from note prefix for old rows)
  and key retention on it. Honest schema over note-string parsing.
- Delete: the previous run's `artifacts/{runId}` directory + its evidence rows (cascade by
  run linkage: evidence ids live in run_steps.evidence_ids_json AND evidence table rows
  keyed by bundle_id=runId — ingestEvidence uses bundle_id=runId, so prune by that).
- Scope: EVERY run kind that stores artifacts (template playback AND automated runner) —
  "videos too" per user. Automated runs key on their own template/flow identity: the runner
  inserts runs with ticket_key — retention groups by ticket_key for automated kind,
  template_id for template kind. (VERIFY runner.ts insert columns before implementing.)
- DB run rows stay (history: statuses, steps, notes); the `evidence` rows and files go.

**Manual-session screenshots: store nothing.** Keep the live thumb display (session page)
but stop persisting engine thumb paths into recording_json… VERIFY: thumbs are referenced,
not copied — the engine's temp files churn on their own. Decision: leave recording_json
shape as-is (paths are references, engine temp-cleans them; no Crucible-side storage
exists to remove). The watch pulse already stores nothing. So goal (1) needs NO change —
document it.

## Self-review findings (verified against code/DB, folded in)

1. **[dissolves Task 1.1-1.2] `runs.template_id` ALREADY EXISTS** — column + FK +
   `idx_runs_template(template_id, started_at DESC)` (schema.ts:233,241); playback's
   insert already sets it (playback.ts:279). Live DB: 3 distinct template ids, 115 NULL
   rows (manual/automated). Retention keys directly on the existing column; NO migration,
   NO backfill needed.
2. **[corrects Task 3] Automated runner does NOT set template_id** (runner.ts:100 insert
   omits it). Its natural group key is `ticket_key`. Decision: automated runs are grouped
   for retention by `ticket_key IS NOT NULL AND template_id IS NULL AND kind='automated'`
   → prune previous automated run of the same ticket_key. Both kinds route into ONE
   primitive: `prunePreviousRunArtifacts({templateId?} | {ticketKey?}, keepRunId)`.
3. **[confirms scope] `video_path` does not exist anywhere** and playback never calls
   `alloy_video` — Task 2 is greenfield as planned. `runs.video_path TEXT NULL` migration
   needed (one line, same pattern as template_id).
4. **[confirms goal 1 is already true]** Manual recording thumbs are engine-temp
   *references* in recording_json (never copied into artifacts/); watch pulse and MJPEG
   stream store nothing. `ls artifacts/` = 163 run dirs, all from playback/automated
   runs. Zero code change for goal 1 — document only.
5. **[edge 2 strengthened]** Concurrent same-template runs: skip prune when the previous
   run has `finished_at IS NULL` (still live) — pruning under a running run would delete
   the evidence it is about to write.
6. **[evidence linkage verified]** `ingestEvidence` writes `bundle_id = runId` into
   `evidence` — prune by `bundle_id = oldRunId` is exact; run rows keep status/steps/note
   (history intact), only files + evidence rows churn.

## Tasks

### Task 1 — schema + retention primitive
Files: `server/src/db/schema.ts` (migration), `server/src/manual/playback.ts`,
new `server/src/evidence/retention.ts` + `server/test/evidence-retention.test.ts`.

1. Migration: `ALTER TABLE runs ADD COLUMN template_id TEXT` (+ index). Backfill:
   `UPDATE runs SET template_id = substr(note, 11, 8) WHERE kind='template' AND note LIKE 'template:tpl_%'`
   — VERIFY note format precisely before writing the substr.
2. Playback insert sets `template_id`; automated runner sets `template_id`/group key (VERIFY
   its insert).
3. `retention.ts`: `prunePreviousRunArtifacts(deps, {templateId, keepRunId})` — find newest
   other run with same template_id, rm its artifacts dir, delete evidence rows by
   bundle_id, null its artifact_path/video_path. Unit tests with tmp dirs + sqlite.

### Task 2 — playback video
Files: `server/src/manual/playback.ts`, tests extend `playback-setup.test.ts`.

1. Fake alloy: `alloy_video` start/stop returning `{video:{hostPath}}` on stop.
2. Start call after settle gate; stop+ingest in finally; `runs.video_path` set on success.
3. Tests: video ingested on pass; video-start failure → run unaffected; video row linked
   via video_path; retention from Task 1 invoked at run start (previous artifacts gone).

### Task 3 — automated runner parity
Files: `server/src/alloy/runner.ts` (+ its insert gains template_id group key),
tests in existing runner test file.

1. Runner insert sets the retention key (ticket_key → template_id or a dedicated column
   value — VERIFY schema fit).
2. Call `prunePreviousRunArtifacts` at run start, same primitive as playback.
3. Existing video flow unchanged (already stops/ingests).

### Task 4 — drill + docs
1. Live: run privacy case twice; after run 2, assert run 1's artifact dir is GONE, run 2's
   screenshot + video exist, DB rows for both intact.
2. Update the playback.ts header comment (evidence policy) + GuidePage artifact blurb if
   it exists.

## Edge cases

| # | Case | Decision |
|---|---|---|
| 1 | Two templates, one device, back-to-back | Independent retention per template_id — no cross-deletion |
| 2 | Same template run twice concurrently | Second run's prune targets the first; if first still running (no finished_at) SKIP prune (don't delete under a live run) |
| 3 | Video stop fails / hostPath null | No video evidence; run verdict untouched; video_path stays null |
| 4 | Artifacts dir missing at prune | rm best-effort, no error |
| 5 | Manual runs (kind='manual') | Never pruned by template retention; they store nothing anyway |
| 6 | First-ever run of a template | No previous → no-op |
| 7 | Backfill note-format mismatch | substr guarded by LIKE prefix; unmatched rows keep NULL → never pruned (safe) |
| 8 | Disk full at ingest | Existing ingest behavior (INSERT OR IGNORE, copy failure logged) — unchanged |

## Out of scope
- Configurable retention count (keep-N) — latest-only is the requirement; N=1 hardcoded.
- S3/offload export.
- Video for manual sessions.
