# Design cleanup — runs log noise, hide monitoring, rewrite guide

- Source prompt: "All the PRs are merged. Now let's do some design clean up — 1. In runs page log, show only the test case name. I don't need to see the addition 'env sources:...' 2. I think I need to hide the monitoring page for now. Ensure the routing invalid too. 3. Check again and rethink the guide page content based on the latest state of the project. You can do it from scratch" (with /hms-brainstorm-rough-ideas)
- Created: 2026-10-05T06:27:06Z
- Status: Direction selected — executing as one cleanup branch

## Goal and context

Three post-merge cleanup items on the web surface. Item 1 is a server-stamped
noise line; item 2 removes a page from the product; item 3 is a content rewrite
of the guide against the current app.

## Confirmed inputs and decisions

- **Item 1 — runs log noise (user)**: "show only the test case name" in the runs
  page log rows. The `env sources: global(n) app(n) plan(n) request(n)` line is
  appended to `runs.note` server-side at playback settle (`server/src/manual/playback.ts:1915-1921`,
  managed-env audit from plan 20260926T122856Z S2.3). The web runs page renders
  the full note on the row (`RunsPage.vue` `noteOf` — only `template:`/`sidebar:`
  prefixed lines are filtered).
- **Item 2 — hide monitoring (user)**: "hide the monitoring page for now.
  Ensure the routing invalid too" — remove the nav entry AND make the route
  unreachable (not just de-listed).
- **Item 3 — guide rewrite (user)**: "rethink the guide page content based on
  the latest state of the project. You can do it from scratch."
- Verified today: 164 of 1087 runs in the dev DB carry `env sources` notes;
  test pin exists (`playback-variant.test.ts:80`); monitoring surface =
  router entry + MonitoringPage.vue + server routes (`server/src/routes/monitoring.ts`,
  registered in index.ts:18, tested in monitoring.test.ts); guide is 501 lines
  of hand-maintained sections; ⌘K palette has NO monitoring entry (verified by
  grep); GuideSlices mock-slices component has 8 `show` values.

## Exploration

**Item 1 options**: (a) filter client-side in `noteOf` — one line, but the noise
stays in every future note and the run detail page still shows it; (b) stop
stamping it server-side — removes it everywhere forever, loses the audit trail
the plan called for. The stamp was an audit line for the managed-env rollout;
counts-only, never values. User calls it noise → the display contract changed.
**Direction**: stop stamping (b), keep the source counts in the resolved-env
payload (they already ride the run's env resolution path if ever needed again);
also strip the line from EXISTING notes' display via `noteOf` filter so current
rows clean up without a DB migration. Server test pin updated to assert the
note no longer carries it.

**Item 2 options**: (a) delete the page + route + server routes; (b) feature
flag; (c) remove route + nav, keep page file. User said "for now" → reversible.
Deleting server routes also breaks monitoring.test.ts. **Direction**: remove the
route from router.ts + nav item from App.vue + the appShell test row, DELETE
MonitoringPage.vue (git revertable — "for now" is served by git history), and
comment out the server route registration (index.ts) with the tests left in
place but skipped? No — dead code with skipped tests is residue. Decision:
remove route + nav + page + appShell references; server side: unregister the
HTTP routes (one-line change in index.ts), leave `routes/monitoring.ts` + its
test file intact (server surface, zero web references — restoring is
re-registering one line). This keeps "hide for now" honest: web-invisible,
server dormant, everything git-revertable.

**Item 3**: full rewrite of GuidePage.vue sections against the verified current
app. Structure: keep the section-nav + card anatomy (house style, works), cut
stale content. Verified stale/changed facts to fix:
- "home page lists every test case as a card" → overview page shows build-level
  health (batch, pass rate, attention, latest runs), NOT a case-card list; "run
  all cases" exists on overview (verified: OverviewPage.vue:155).
- cockpit replaced /drive: wall "drive" button → /cockpit?device= (verified);
  watch|chat rail, tabs, env drawer, app menu, inspect — the old drive-section
  (tap canvas/lease/dpad scroll) describes the deleted page.
- record tooling: DeviceSidebar (wall) still has record toggle (verified
  DeviceSidebar.vue:1045); cockpit is inspect-only. Guide must say where record
  lives now.
- suites board + "runs from this suite" (verified SuitesPage) — accurate.
- matrix/acceptance criteria still exists (deep-link + ⌘K + run detail link,
  verified) — but described "ticket… box" on wall no longer exists (grep empty);
  "+ new run" modal was REMOVED (skill: NewRunModal removed in 016 batch).
- status vocabulary: changes-pending/quarantined exist in code
  (domain/status.ts, MatrixPage) — keep but recheck wording; "amber ≠ fail"
  card stays.
- env page exists (/env, scoped variables, usage strip) — guide has NO env
  section; screens page (/screens registry) — guide has NO screens section.
  Both are user-facing library surfaces now (sidebar "library" group).
- freshness/stale gate — still real (guide ok).
- keyboard section — ⌘K palette verified.
- monitoring — being hidden this round → no guide section.

## Open questions

None blocking. (Env/screens guide depth: light-touch sections; the pages
themselves are self-describing and the guide's job is the loop, not the
inventory.)

## Next step

Execute on branch `feat/design-cleanup-2`: (1) playback.ts stop-stamp +
RunsPage noteOf filter for legacy rows + test pin update; (2) router/nav/page/
test removal + server unregistration; (3) GuidePage.vue rewrite from scratch
keeping the shell anatomy; verify (check/test suite + live drill); PR.
