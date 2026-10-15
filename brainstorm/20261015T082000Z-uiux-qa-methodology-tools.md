# QA-ing website UI/UX — methodology & tooling research

- Source prompt: "I'm really getting sick of UI/UX bugs. Can you do a deep research if there is a way or methodology or tools/MCP to QA website UI/UX?"
- Created: 2026-10-15T08:20:00Z
- Status: Direction selected

## Decision log (user, 2026-10-15)

1. CI: "I think so. But I think Github Actions will be a blocker since I'm not a paid user" → **local-first gating via `pnpm run check`** (GitHub Actions free tier exists for private repos with limited minutes, but design assumes no CI; revisit only if wanted).
2. Scope: "Start with migrated pages and grow with Phase 3" → visual+axe suite covers `/` (overview) + `/audit` now; each Phase-3 page migration appends its route.
3. Budget: "self-hosted forever. Although, Lionidas itself will also have a web engine for the end-to-end testing later." → no SaaS ever (Stage 3 dropped). **Design constraint: the QA harness must stay thin and swappable** — route/mock tables in one place — because Lionidas' own web engine will eventually replace the Playwright runner.

## Goal and context

The user wants a systematic way to stop UI/UX bugs before human review — for
the Lionidas web app (Vue 3 + shadcn, Factory theme, 21 pages mid-migration)
and for Hermes-agent workflows generally. Context: this session shipped two
user-caught visual regressions (ledger toolbar composition drift; `<button>`
shrink-wrap grid bug) that DOM-metric checks did not catch. Confirmed by the
user catching them in screenshots.

Interpretation (mine): the ask covers both (a) classic CI-able QA tooling and
(b) agent-driven QA (MCP servers, vision models) that fits how we already
work — Hermes + Playwright MCP + a now-working vision tool.

## Confirmed inputs and decisions

- User hates UI bugs; wants research into methodology/tools/MCP (verbatim prompt above).
- Session evidence: DOM-assertion-only verification missed real layout bugs; vision-based screenshot inspection caught them.
- Hermes already has: Playwright MCP (browser automation), axe-core as web
  devDep (already used in drills), vision_analyze now working on zai/glm-5.3.
- Lionidas stack: pnpm monorepo, web = Vite + vitest (104 tests), server tests
  green; `pnpm run check` is the gate. No CI pipelines observed in repo (unverified — needs check).

## Exploration

### The landscape (researched 2026-10-15)

Three complementary layers, all mature:

**1. Visual regression testing (pixel/layout diffing vs baseline)**
- **Playwright `toHaveScreenshot()`** — built into the test runner we already
  use via MCP; pixelmatch-based; baselines in git; `--update-snapshots` flow;
  `maxDiffPixelRatio`/`threshold` to tune noise; `stylePath` CSS to mask
  dynamic elements. Free, local, deterministic-ish. THE natural fit: our
  drills already produce screenshots; this turns them into assertions.
- **Argos** — OSS core, local capture in your real browser, free 5k
  screenshots/mo, review UI + CI gating. Recommended by Argos' 2026 roundup.
- **Chromatic** — Storybook-first (we have no Storybook), cloud render,
  $179/mo+, a11y checks included. Poor fit (no Storybook, paid).
- **Percy** (BrowserStack) — DOM-upload cross-browser re-render, $599/mo,
  AI Visual Review Agent + MCP (late 2025). Strongest cross-browser story,
  expensive.
- **Applitools Eyes** — Visual AI match levels (Strict/Layout/Dynamic) that
  kill antialias/subpixel false positives; DOM/CSS root-cause analysis; **Eyes
  MCP server** purpose-built for agent loops (agent reads diff → fixes CSS →
  reruns). Enterprise pricing, but the MCP concept is exactly the agentic QA
  pattern. Their tutorial demos an agent fixing a clipped mobile button via
  MCP diff+DOM context — the same class of bug we shipped.
- **Lost Pixel** — WAS a good OSS option; team joined Figma Apr 2026, product
  sunsetting. Avoid.
- **BackstopJS / reg-suit** — free, local, URL-based; more config burden, no
  review UI.

**2. Accessibility & structural checks (already partially in place)**
- **axe-core + Playwright** (`@axe-core/playwright`) — the standard; we
  already inject axe manually in drills; productizing = a small spec file
  iterating routes × viewports. Consensus best practice: gate on
  serious/critical, baseline existing violations, SARIF annotations in PR.
- Covers ~57% of WCAG (structural half); keyboard/focus-order/behavioral half
  stays manual or scripted (we already script tab-chain walkthroughs).
- Lighthouse CI — broader audit incl. a11y score; weaker as gate (score hides
  which rule failed).

**3. Agent-driven QA (MCP + vision) — the layer that fits us**
- **Playwright MCP** (microsoft) — accessibility-tree snapshots, 70+ tools,
  `--caps=testing` adds assertion tools. We already run this.
- **Applitools Eyes MCP** — visual diffs + DOM root cause into agent context.
- **Percy MCP** — same idea on BrowserStack infra.
- **Our own stack**: Playwright MCP screenshots + vision_analyze (now working)
  = a poor-man's Eyes: prompt the vision model with the screenshot + a
  checklist (alignment/overlap/spacing/contrast) per page per viewport. This
  is exactly what caught the last two bugs when we finally ran it.
- **AI UX heuristic auditors** (Fleck UX Audit, uxaudit.dev, Snap Site,
  AuditAI) — SaaS: screenshot/URL in → Nielsen-heuristic findings with
  severity out. Interesting for one-off audits of key screens; not CI-able,
  login-walled apps problematic, quality unverified. Cheap to try; not core.

### Methodology (what teams actually do — the part tools can't fix)

1. **Baselines are contracts**: capture approved screenshots per page ×
   viewport × theme; diff every change; intentional change = explicit
   `--update-snapshots` commit reviewed like code.
2. **The gate ladder** (fast → slow): lint-time (a11y lint) → unit/component
   (jest-axe/vitest-axe) → E2E rendered-page axe + visual diff (per-PR) →
   periodic full crawl + human pass.
3. **Baseline the backlog, gate on NEW** — don't fail the build on 400 legacy
   violations; snapshot today's state, block only regressions.
4. **Agent protocol** (what we lacked): any UI change ⇒ screenshot at 375+1440
   in both themes ⇒ vision-model defect checklist ⇒ fix before claiming done.
   This session's two escapes both violated this protocol.

### Recommendation (proposal)

For Lionidas + Hermes, three stages by cost/benefit:

- **Stage 1 (now, free, ~half day): Playwright visual snapshots + axe spec in
  `web`** — add `@playwright/test` + `@axe-core/playwright` to web devDeps; a
  `web/e2e/visual.spec.ts` iterating the 21 routes × [375,1440] × [dark,light]
  with mocked API (reuse drill mocks); `toHaveScreenshot({ maxDiffPixelRatio:
  0.002 })`; axe scan in the same pass; wire into `pnpm run check`. Baselines
  committed. This alone catches both of this session's bug classes
  automatically forever.
- **Stage 2 (agent protocol, no new deps): vision-QA in the Hermes workflow** —
  codify "screenshot + defect checklist via vision_analyze before done" into a
  skill (e.g. `ui-qa-gate`) so every future UI task loads it. Optionally a
  nightly full-page vision sweep.
- **Stage 3 (only if Stage 1 proves insufficient): SaaS AI diffing** — Eyes or
  Percy MCP for cross-browser + noise-filtered diffs. Cost-justified only when
  multi-browser coverage or false-positive burn becomes real.

## Open questions

None — all three gates answered (see decision log above).

## Next step

Answer the three questions → plan (hms-plan-from-brainstorm) for Stage 1 →
review → implement. Stage 2 skill can land alongside without a plan gate
(it's workflow, not product code).

## Sources

- Playwright visual comparisons — playwright.dev/docs/test-snapshots
- Argos "9 Best Visual Regression Testing Tools 2026" — argos-ci.com (pricing,
  Lost Pixel sunset, Chromatic/Percy positioning)
- Applitools Eyes + Eyes MCP agent tutorial — applitools.com/docs
- Percy AI Visual Review + MCP — browserstack.com/percy
- Playwright MCP — github.com/microsoft/playwright-mcp
- axe-core in CI best practices — wcagc.com, a11yeco.com, helpmetest.com
  (baseline-not-backlog pattern, SARIF, 57% coverage figure)
- AI UX auditors — fleck.ai/ux-audit, uxaudit.dev, snapsiteux.com
