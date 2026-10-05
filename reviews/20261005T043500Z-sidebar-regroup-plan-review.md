# Review — sidebar regroup plan (A collapsible tree)

- Plan: plans/20261005T043500Z-sidebar-regroup-plan.md
- Verdict: **Ready for implementation** (2 findings, both folded into the build)
- Scope: nav-only regroup; routes frozen; grounded in App.vue:39-66, layout.css:33-70, router.ts.

## Findings

- **[M1|Medium] App test mount needs router + fetch stubs.** App.vue's setup
  calls `/api/auth/me` on mount and uses `useRoute`/`useRouter`. The existing
  vitest chain mounts bare components — the new test must mount App with a real
  `createRouter` (memory history) and a `vi.stubGlobal('fetch', …)` returning
  `{ user: null }` or the mount throws and every assertion reads as failure.
  Plan §Tests amended accordingly.
- **[L1|Low] Auto-expand watch must be immediate.** On hard load all groups
  start expanded (no persistence — brainstorm decision), so a plain watch
  suffices in-session, but `immediate: true` costs nothing and makes the
  route→group invariant hold from first paint. Folded into build.

## Verified during review

- Route→group mapping matches router.ts names 1:1 (overview/suites/wall/runs/
  runDetail; templates/screens/env/forge; monitoring/users/guide) — no orphan
  routes left outside the nav (cockpit fullscreen + matrix deep-link + login
  public stay out, unchanged).
- `.a2-group-head` (components.css:309) is grid-table-scoped — correctly NOT
  reused; the sidebar gets its own head idiom in layout.css per the sketch.
- Branch plan correct: fresh branch from main (in-sync with origin), cockpit
  work rides PR #16 untouched.
- Mobile rule (`sidebar display:none <768px`) untouched by the change.

## Residual risk

None material. Nav-only, no data contracts, no server surface.
