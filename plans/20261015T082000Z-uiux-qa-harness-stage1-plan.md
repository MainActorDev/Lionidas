# UI/UX QA harness (Stage 1) — Implementation Plan

> **For Hermes:** implement task-by-task with verification between each. The
> harness must stay thin and swappable — Lionidas' own web engine replaces
> the Playwright runner later (user, 2026-10-15).

**Goal:** Automated visual-regression + accessibility gates for the migrated
pages (`/`, `/audit`), running locally via `pnpm run check`. Catches the two
bug classes that escaped this session (composition drift vs approved design;
layout/width bugs invisible to DOM assertions).

**Source brainstorm:** `brainstorm/20261015T082000Z-uiux-qa-methodology-tools.md` — decision log:
local-first (no CI assumption), migrated-pages scope growing with Phase 3,
self-hosted forever, thin/swappable harness.

**Architecture:** a standalone Playwright Test project in `web/e2e/` (separate
from vitest — different runner, real browser). One **route table** file lists
routes + per-route API mocks; one spec file iterates the table × viewports ×
themes doing (a) `toHaveScreenshot()` visual baselines and (b) axe-core scans.
The web server is built (`vite preview`) then driven headless. When Lionidas'
own web engine arrives, only the runner (spec file) is replaced — route table,
mocks, and baselines survive.

**Key choices:**
- `@playwright/test` + `@axe-core/playwright` as `web` devDeps (axe-core already present).
- Baselines: PNG in git under `web/e2e/__screenshots__/` (Playwright default
  path), committed like code; intentional change = `--update-snapshots` in a
  reviewed commit.
- Determinism: fixed viewport set [375, 1440] × themes [dark, light];
  `reducedMotion: 'reduce'`; mocked APIs (deterministic timestamps via a
  frozen clock seed — data identical every run); `animations: 'disabled'`;
  caret/timeout masks where needed.
- Threshold: `maxDiffPixelRatio: 0.002` + `threshold: 0.2` (industry-standard
  starting point; antialias noise tolerance).
- axe gate: 0 violations at serious+ for covered routes (we are at 0 now —
  no baseline-backlog dance needed).
- `pnpm --filter web test:e2e` script; NOT wired into `pnpm run check`
  initially (needs browser install + slower); wire in after it proves stable
  (Task 4 decision point, default: wire it in).

---

## Task 1 — Runner scaffold + route table + mocks

**Files:** `web/e2e/` (new dir): `playwright.config.ts`, `routes.ts` (route
table + mock data), `visual.spec.ts`, `package.json` scripts, devDeps.

1. `pnpm --filter web add -D @playwright/test @axe-core/playwright`;
   `npx playwright install chromium` (single browser — local, deterministic).
2. `playwright.config.ts`: `webServer: vite preview` (port fixed, `reuseExistingServer: !process.env.CI`), projects per viewport [375×900, 1440×900], `expect.toHaveScreenshot` defaults (threshold/maxDiffPixelRatio/animations), `snapshotPathTemplate` including theme + route + viewport.
3. `routes.ts`: entries for `/` (overview) and `/audit`; **full
   pre-navigation mock set** (review H1 — the router guard fetches auth/me on
   every nav and redirects to /login on failure): auth/me, me/capabilities,
   setup/state 404, runs, devices, plans, overview, audit — ALL registered
   BEFORE goto, with FIXED timestamps (`2026-10-15T09:00:00Z`-anchored rows so
   day-grouping is deterministic) + fixture data from the drill arrays.
4. Spec skeleton: for each route × viewport × theme — set viewport, register
   ALL mocks, set `.dark` class or not, goto, wait for content predicate
   (e.g. `.row` count > 0), assert URL is the target route (NOT /login —
   review H1 pass criterion), then (placeholder) screenshot. Config sets
   `use: { locale: 'en-GB', timezoneId: 'UTC' }` so toLocaleString output is
   machine-independent (review M1).
5. Verify: `pnpm --filter web test:e2e` runs, hits both routes both themes
   both viewports, zero flake across 3 consecutive runs.

## Task 2 — Visual baselines

1. Replace placeholder with `await expect(page).toHaveScreenshot({ fullPage: true })` — 8 baselines (2 routes × 2 viewports × 2 themes).
2. Generate + commit baselines; verify a second run passes with zero diffs.
   Start with fullPage screenshots; if sticky-header artifacts appear in the
   stitched image, fall back to viewport-height captures (review M2 —
   disclose which was chosen).
3. Mutation test (proves the gate works): temporarily inject the
   shrink-wrap bug (`width: 100%` removed from `.row`) → run → must FAIL
   with a diff; revert → passes. Record result in plan Results.
4. Same mutation test for composition drift: swap toolbar `.q` background to
   `transparent` → must fail; revert.

## Task 3 — axe gate in the same pass

1. In the same spec iteration (after screenshot), run
   `AxeBuilder.withTags(['wcag2a','wcag2aa'])`, assert `violations` empty.
2. Verify green on both routes; if any violation appears, fix the PAGE (not
   the test) — we hold 0-violation state.
3. Include the open-state surfaces already known to matter: audit detail
   Sheet open (click first row before screenshot+scan).

## Task 4 — Wiring + docs + agent protocol skill

1. Decide check-wiring: if `test:e2e` runtime < ~90s and stable, add to
   root `pnpm run check` after the web suite; else document the manual
   command + leave check unchanged (disclose which and why).
2. `web/e2e/README.md`: how baselines work, how to update intentionally,
   how to add a route (Phase-3 growth path), runner-swap note.
3. Create Hermes skill `ui-qa-gate` (Stage 2 from brainstorm): the agent
   protocol — every UI change: screenshot 375+1440 both themes, vision
   checklist, fix before done; run test:e2e before claiming complete.
4. Update plan Results; report.

---

## Acceptance criteria

- `pnpm --filter web test:e2e` green ×3 consecutive runs (no flake).
- 8 committed baselines; mutation tests (Task 2.3/2.4) demonstrated FAIL→PASS.
- axe 0 serious+ on all covered route×viewport×theme combos incl. Sheet-open.
- Route table + mocks isolated in `routes.ts` (swap-ready for Lionidas engine).
- No changes to product code except any axe-driven page fixes.
- `pnpm run check` still green; web vitest suite untouched (104/104).

## Risks

- **Font loading (Geist via Google Fonts)** — network-dependent; mitigate:
  `await page.evaluate(() => document.fonts.ready)` + retry; if still flaky,
  self-host fonts in test profile or block external fonts with a local
  fallback for determinism (disclose if so).
- **vite preview vs dev** — preview serves the build; build step adds ~10s
  but determinism wins. Webserver reuses existing when debugging.
- **Baseline churn on token changes** — expected and correct: Factory theme
  edits WILL change screenshots; that's the contract working. Update via
  reviewed `--update-snapshots` commits.
- **happy-dom vitest ≠ real browser gaps** — some assertions may differ;
  keep vitest suite untouched; e2e is additive.
