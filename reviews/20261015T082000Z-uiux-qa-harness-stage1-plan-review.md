# Review — UI/UX QA harness Stage 1 plan

- **Plan reviewed:** `plans/20261015T082000Z-uiux-qa-harness-stage1-plan.md` (2026-10-15)
- **Sources:** brainstorm `20261015T082000Z-uiux-qa-methodology-tools.md` + decision log (3 user answers); repo state (web/package.json devDeps, vitest.config, router guard at `web/src/router.ts:52-70`, Phase-2 screenshots dir).
- **Verdict: Ready for implementation** — one High correction applied to the plan (H1), two Medium notes.

## Traceability

- "local-first / no CI assumption" → webServer `reuseExistingServer`, no workflow files; check-wiring is an explicit decision point (Task 4.1) not an assumption. ✓
- "migrated pages, grow with Phase 3" → routes.ts table with exactly `/` + `/audit`; README documents the append path. ✓
- "self-hosted forever / thin swappable harness" → zero SaaS deps; runner-only spec file; route table + mocks isolated. ✓
- Verified: `@playwright/test` + `@axe-core/playwright` are the standard local stack (Playwright docs; axe-in-CI guides); baselines-in-git is the documented Playwright flow (`--update-snapshots`). ✓

## Findings

**H1 — Router auth-guard will bounce headless tests (verified in repo).**
`web/src/router.ts:52-70`: every navigation fetches `/api/auth/me`; on failure
it redirects to `/login?redirect=…`. This session's Playwright drills needed
ALL API mocks (incl. `/api/runs`, `/api/devices`) registered *before* goto,
or the app landed on /login. The plan says "mocked APIs" generically —
insufficient. **Correction applied:** Task 1.3 now requires the full mock set
(auth/me, me/capabilities, setup/state, runs, devices, plans, overview, audit)
registered pre-navigation, and Task 1.5's pass criterion includes "lands on
the target route, not /login". This was the #1 drill failure mode today.

**M1 — Fixed timestamps vs `fmtTime` locale rendering.** Deterministic data
uses fixed epoch times; `toLocaleString` output depends on the machine's
locale/timezone → baselines differ across machines. Correction folded into
plan: run Playwright with `process.env.TZ = 'UTC'` + `locale: 'en-GB'` via
`use: { locale, timezoneId }` in config. (Otherwise every collaborator/machine
regenerates baselines.)

**M2 — fullPage screenshots + sticky elements.** `fullPage: true` with
sticky day headers/sidebar can duplicate or clip them in the stitched image;
Playwright handles most cases but sticky headers sometimes render oddly.
Mitigation folded into plan Task 2.1: start with fullPage; if a sticky-header
artifact appears, cap to viewport-height screenshots with a scroll pass
(disclose in Results which was chosen).

**L1 — Geist via Google Fonts (plan Risks already covers).** Keep
`document.fonts.ready` wait; if network-blocked environments flake, the
fallback (self-host in test profile) is documented.

## What stays open during implementation

- Whether `test:e2e` joins `pnpm run check` (Task 4.1 decision point —
  runtime < ~90s and stable, else documented manual).
- Mutation-test details (which exact CSS to flip) — plan gives two concrete
  cases from this session; implementer may substitute equivalent ones.

## Required plan edits (applied by reviewer before coding)

1. Task 1.3: full pre-navigation mock set enumerated; Task 1.5: "lands on
   target route not /login" pass criterion (H1).
2. Config: `use: { locale: 'en-GB', timezoneId: 'UTC' }` (M1).
3. Task 2.1: sticky-artifact fallback noted (M2).

Verdict stands: Ready.
