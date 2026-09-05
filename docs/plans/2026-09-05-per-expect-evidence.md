# Per-Expect Evidence — step-labeled screenshots + reliable run video

> **For Hermes:** TDD, small batches, live drill at the end.
> **User decisions (2026-09-05):** row thumb = FAILED expect's screenshot when any
> expect failed, else last expect's. Video records the WHOLE run and must be reliable.

## Design

**Per-expect screenshots (playback):** after an `expect` step resolves (pass OR fail —
the failure screen is the evidence), dispatch `alloy_screenshot`, ingest as evidence
`bundle_id=runId, type='screenshot'`, and record the ev id on the step's
`evidence_ids_json`. Best-effort: a screenshot failure never changes a step's verdict.
The existing run-final screenshot in `finally` is REMOVED for template runs —
superseded by step evidence (keep for paths where no expect ran? The failed/blocked
runs still want a "where it died" frame: keep the finally-shot ONLY when no expect
evidence exists for the run).

**Row-thumb semantics (resolver):**
```
thumb-run evidence = failed expect's screenshot, else last expect's screenshot
```
- SQL: newest finished run per template; among its evidence rows prefer the
  screenshot linked to a FAILED expect step (earliest failed expect — the first
  break in the chain), else the LAST expect step's screenshot.
- Steps carry evidence ids ordered by idx — resolver joins run_steps
  (kind='expect' path: name LIKE 'expect%') with evidence by id, picks:
  first idx where status='fail', else max idx.

**Lightbox gallery:** thumbnails per expect (label = step name + verdict chip,
red/green), main view = clicked image full-size; video toggle unchanged at top
(whole-run recording). Data source: extend the list flag join or a tiny
`GET /api/templates/:id/evidence` (list) returning [{stepIdx, name, status, evId}] —
the lightbox fetches it on open. Reuses the same file route.

**Video reliability (the silent failure):** current start is `.catch(() => null)`
AFTER the settle gate; failures are invisible. Changes:
1. Start the video BEFORE the app-open (earliest possible moment — open + settle
   + steps all recorded; today the pre-step window is lost).
2. Log failures via the run note (`video unavailable: <reason>`) so absence is
   explainable, not silent.
3. Diagnose the intermittent engine-B failure in the drill: capture the error
   code from the start/stop dispatch (the fakes/tests already exercise ok/false
   shapes). If it's the device-lease contention with engine A's session (video
   is engine-B, the app session is engine-A), sequence: start video AFTER
   `alloy_apps open` returns but before steps — both engines' per-call/held
   leases coexist today (the automated runner already starts video while A's
   session is open), so this is likely fine; verify in drill.

**Retention:** unchanged — prune deletes the whole run dir + evidence rows; step
`evidence_ids_json` nulled with it (already implemented).

## Self-review findings (verified in code)

1. **[Task 1 shape] Expect rows write evidence at INSERT time** — the pass/fail
   `insStep.run(..., '[]', ...)` calls carry the evidence array literally
   (playback expect branch). The screenshot must be captured and ingested
   BEFORE the insStep call so the row is born with its evidence id — no
   post-insert UPDATE needed.
2. **[Task 4 verified] video start sits at playback.ts:526** (after settle
   gate). Moving pre-open = relocate to right after the run INSERT + retention
   prune, before `alloy_apps open`. The `.catch(() => null)` swallows the error
   — replace with a note-line on failure so absence is explainable.
3. **[skip firecodind risk] optional-expect skip path** writes its own
   insStep('skip') row — no screenshot there (correct: nothing was proved).
4. **[ambiguity noted] `matched > 1` (ambiguous)** fails the expect — capture
   the screenshot for it too (same fail branch).

## Tasks

### Task 1 — per-expect screenshot capture
Files: `server/src/manual/playback.ts`; tests `playback-setup.test.ts`.
1. In the expect branch (post resolution, verdict known): screenshot → ingest →
   push ev id into the step's `evidence_ids_json` at insStep time (capture BEFORE
   insStep.run so the row is born with its evidence).
2. `finally` screenshot kept only when the run produced zero expect evidence.
3. Tests: expect-pass carries evidence id; expect-fail too; zero-expect run keeps
   finally-shot; screenshot dispatch failure changes nothing.

### Task 2 — resolver prefers failed-expect shot
Files: `server/src/routes/templates.ts`; tests `templates-yaml.test.ts`.
1. Screenshot resolver: join run_steps × evidence, prefer first failed expect's
   screenshot, else last expect's, else (fallback) any screenshot evidence.
2. Tests: failed-expect preferred; all-pass → last expect; no-expect → fallback.

### Task 3 — evidence list for the lightbox
1. `GET /api/templates/:id/evidence` → for the newest finished run:
   `[{stepIdx, stepName, status, kind:'screenshot'|'video', evId}]` (video last).
2. Tests: shape + ordering (idx asc, video appended).

### Task 4 — video reliability
1. Move video start pre-open (right after run insert / lease acquired, before
   alloy_apps open); note-line on failure.
2. Drill: verify MP4 exists for a full run; if engine-B start fails, the note
   names the error; video scrub via Range through the lightbox.

### Task 5 — UI gallery
1. Lightbox: horizontal strip of expect thumbs (label + verdict dot), click to
   enlarge; video toggle in header (only when video evidence exists).
2. Row thumb unchanged in position/size (user only disliked placement → moved?
   NO — user said the placement was ugly BEFORE seeing content; with per-expect
   thumbs the SAME 28px leading slot now shows the most meaningful frame. Keep
   slot, revisit only if still disliked.)

### Task 6 — live drill + commit
1. Run privacy case: 1 expect → 1 labeled screenshot + video.
2. Break the case (bad expect fragment) → failed-expect shot becomes thumb.
3. tnc never-run → no thumb. Supersede → swap.

## Edge cases
| # | Case | Decision |
|---|---|---|
| 1 | Multiple failed expects | First failure's shot (the break point) |
| 2 | Optional expect skipped | No screenshot (nothing proved) |
| 3 | Expect inside runFlow child | Same rule — step rows are flat at playback |
| 4 | Screenshot dispatch fails mid-run | Step still records verdict; no evidence id; note logs it once |
| 5 | Video start fails | Run proceeds; note explains; lightbox hides video |
| 6 | Very long runs (video size) | Whole-run recording is the requirement; Range streaming already handles size |
| 7 | No expects at all | finally-shot fallback for the thumb |

## Out of scope
- Screenshot-on-tap (only expects, per user).
- Video trimming/chapters.
- Configurable capture points.
