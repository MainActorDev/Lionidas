# Case-Rule Evidence — thumbnail + video on the Test Cases page

> **For Hermes:** TDD where logic exists (route guard, verdict join); template markup is
> presentational. Live check at the end. User scope (2026-09-05): ONLY the Test Cases
> page — RunDetail/Runs-list/Jira are explicitly out.

## Design

**Serving route** — `GET /api/templates/:id/evidence/:kind` (kind: `screenshot` | `video`):

- Resolve: newest run with `template_id = :id` AND `kind='manual'` AND
  (`artifact_path IS NOT NULL` for screenshot / `video_path IS NOT NULL` for video).
  Latest-only retention guarantees at most one generation exists; the query still picks
  newest-first for safety. 404 when the template has no run yet / run has no such artifact.
- Stream from the run's artifact dir with content-type (`image/png` / `video/mp4`),
  Range-pass-through for video scrubbing (`reply.header('accept-ranges')` + raw stream is
  enough for Fastify + video seeking over localhost; verify in drill).
- **Path-traversal guard**: the served path MUST come from the DB row
  (`runs.artifact_path`/`video_path`), never from request input; additionally assert the
  resolved absolute path startsWith the configured artifacts dir before streaming
  (defense in depth — engine temp paths are copied into artifacts by ingestEvidence, so
  DB rows should always point inside artifacts/, but the assert makes it a rule).
  NOTE: live DB rows currently hold the ENGINE temp paths for screenshot/video
  (`/var/folders/.../agent-device-screenshot-*/…`, `…/argent-recordings/…`) because
  `runs.artifact_path`/`video_path` are set from the SOURCE path, not the INGESTED copy.
  Fix as part of this task: set both columns from the ingested destination inside
  artifacts/ (ingestEvidence already returns the ev id; capture dest path — return it).
- Cache header: `Cache-Control: no-store` (evidence changes when a new run supersedes;
  browsers must not pin stale thumbs).

**List payload** — TestCasesPage needs to know which cases HAVE evidence without N+1:
`GET /api/templates` (rowToTemplate or the suite join) gains per-template
`evidence: { screenshot: boolean; video: boolean }` — one GROUP BY join over runs.

**UI — the case row** (7-col grid today): add the thumbnail INSIDE `col-case` as a small
leading image (24-32px, rounded, same slot as the app icon pattern on col-app —
NOT a new grid column, keeps the layout stable):

- Thumb = `<img :src="/api/templates/{id}/evidence/screenshot">`, lazy, onerror hides.
- Click → lightbox overlay (existing pattern: the app has modal patterns in
  PresetEditorModal/CaseEditor) showing the screenshot full-size with a "▶ watch video"
  toggle to the inline `<video controls>` player (native, no deps).
- `col-verdict` stays as-is; the lightbox header shows the case name + run time.

## Self-review findings (verified against code, folded in)

1. **[dissolves most of Task 2] An evidence file route ALREADY EXISTS** —
   `server/src/routes/evidence.ts`: `/api/evidence/:id/file` streams with Range
   (206), content-type (video/mp4), and 410-on-missing. Do NOT build a second
   streaming implementation. The template route becomes a resolver:
   `GET /api/templates/:id/evidence/:kind` → newest finished run's evidence row
   (bundle_id=runId, type=kind) → `reply.redirect('/api/evidence/{evId}/file')`.
   Browsers follow redirects for img/video src natively. Range scrubbing rides
   the existing route.
2. **[Task 1 root cause confirmed]** `ingestEvidence` returns the evidence id
   only; playback/runner set `runs.artifact_path`/`video_path` from the SOURCE
   (engine temp) path — that's why live DB rows point at `/var/folders/...`.
   Change: return `{ id, path }`; callers set run columns from the INGESTED
   path. Two ingest implementations exist (playback.ts:102, runner.ts:57) —
   playback is this task's scope; runner gets the same two-line fix since its
   writes have the identical flaw (artifact_path already points at temp).
3. **[redirect + no-store]** redirect carries no cache headers of its own; the
   evidence file route sets none today. Add `Cache-Control: no-store` on BOTH
   the resolver and the file route (superseded runs must not pin stale thumbs).
4. **[UI shape confirmed]** `col-case` hosts name + ticket + tags (grid col 1);
   a leading 28px thumb fits the existing pattern (col-app already does icons).
   Lightbox: no shared modal component exists — small inline overlay in this
   page, Escape + backdrop click, `<video controls preload="metadata">`.

## Tasks

### Task 1 — ingestEvidence returns dest; playback stores ingested paths
1. `ingestEvidence` returns `{ id, path }` (or a second tiny helper) — playback's
   screenshot + video writes set `runs.artifact_path` / `runs.video_path` to the
   INGESTED path inside artifacts/. Automated runner's two writes get the same
   treatment (`runner.ts` screenshot + video).
2. Unit test: after a playback run with fake screenshot+video, both columns point
   inside artifacts/{runId}/.

### Task 2 — serving route + list flag
1. `GET /api/templates/:id/evidence/:kind` as designed (DB-resolved path, artifacts-dir
   assert, no-store, 404s). Range support for video.
2. `GET /api/templates` gains `evidence: {screenshot, video}` per template.
3. Tests: 404 (no run / no artifact), traversal attempt via kind rejected (kind is an
   enum, request path never touches fs), streams bytes + correct content-type,
   evidence flag true/false.

### Task 3 — TestCasesPage UI
1. Row: leading thumb in col-case (hidden when no screenshot).
2. Lightbox: full screenshot + video toggle. Click-outside/Escape closes.
3. No new grid column; verify at 1280 and narrow widths (grid minmax already guards).

### Task 4 — drill + polish
1. Live: fresh run of privacy case → thumb appears on its row; click → lightbox → video
   scrubs (Range works). Supersede with a second run → thumb/video swap to the new run's
   (retention already handles storage).
2. tnc template (never run since retention) shows no thumb (404 → hidden).

## Edge cases
| # | Case | Decision |
|---|---|---|
| 1 | Template never run | 404 → thumb hidden, no UI flash (onerror + v-if flag) |
| 2 | Run superseded mid-view | Lightbox holds the old URL until closed; no-store refresh gets new |
| 3 | Video file large (14MB) | Native player + Range; no preload (metadata only) |
| 4 | artifact_path pointing outside artifacts (legacy rows) | Route's startsWith assert → 404 (safe), Task 1 prevents new ones |
| 5 | Concurrent template runs | Retention skips live runs; route picks newest FINISHED (finished_at NOT NULL) |

## Out of scope (user decision)
RunDetail evidence section, Runs-list badges, Jira attachment enrichment.
