# Tap-overlay evidence recordings (Tier 2.2)

Recorded runs' evidence videos show **where the finger landed** — fading
tap circles over the video, same visual language as the live RunPanel
markers. Reviewer no longer cross-references the step table.

Live-verified 2026-09-05 on `run_ac3062d4` (privacy template, LP app):
3 taps persisted, each circle's fraction lands on the real element the
step targeted (Account tab, Password field, optional-dismiss area).

## Mechanism

```
record:  playback tap/type dispatch ──► run_taps (ts=epoch ms, logical pt)
         startVideo() success ──► runs.video_started_at (anchor)
serve:   GET /api/templates/:id/run-taps → {runId, videoStartedAt, taps}
play:    <video> + <canvas>; rAF: overlayAt(taps, anchor,
         video.currentTime*1000, 1400ms) → markers (fx/fy + fade)
```

- `overlayAt()` lives in `@crucible/shared/tap-overlay` — playheadMs is
  VIDEO-RELATIVE (`video.currentTime*1000`), tap ts absolute, aligned
  via the anchor. Linear fade over 1400ms.
- `latestFinishedRun()` (routes/templates.ts) is the ONE selector for
  which run's evidence is served — video route, taps route, gallery all
  call it; they can never disagree.
- Route is `/run-taps`, NOT under `/evidence/:kind` (that param route
  would swallow it — self-review defect, plan §Task 0.3).

## Guards & fallbacks

- `recordTap()` rejects zero-dims (pre-snapshot `targetW ?? 0`) and
  out-of-bounds points — fraction math can't be poisoned.
- No `video_started_at` (video was unavailable) ⇒ taps route 404 ⇒
  player renders plain video. Overlay never blocks playback.
- `run_taps` rows cascade-delete with the run (retention unchanged).

## Known limits

- **Manual/QA runs only** — the automated path (`runner.ts`, engine-B
  flows) emits no tap coordinates; overlay needs engine-B flow events
  first (future work).
- Tap and **type** steps recorded (a fill lands at a spot). Scroll has
  no point semantics — excluded; swipe-path viz is future work.
- Server-side ffmpeg burn-in (Jira-attachable baked-in circles):
  follow-up script when a Jira-attachment workflow exists. No ffmpeg
  dependency was added for this feature.
