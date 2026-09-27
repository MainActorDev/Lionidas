# README header redesign — brainstorm

- Source prompt: "update the README.md thoroughly. Kinda follow the screenshot for the header structure. Use the dark mascot (centered) at the top."
- Created: 2026-09-27T15:55:00Z
- Status: Direction selected

## Goal and context

Operator wants the README rebuilt thoroughly (the current one is a 55-line M0-scaffold stub still describing "Status: M0 (scaffold)") with a header structure following the attached screenshot (a polished GitHub README: centered title, divider, badge row, tagline, section-link navigation) and the dark mascot avatar centered at the top. The body should reflect what Lionidas actually IS today, not the M0 stub.

## Confirmed inputs and decisions

- Screenshot structure (vision-verified 2026-09-27): centered **title → divider → badge row → bold tagline → language links → shields badges → section-link nav row** (`Usage · Commands · FAQ …`). We adapt: language links and Discord badges are NOT ours to fake — dropped. Trending badge is theirs — dropped.
- Dark mascot at top, centered: `avatars/lionidas-avatar-dark-512.png` exists in the icon pack (512px, dark plate). Repo-relative path needed: `docs/assets/` or `web/public/icons/` (already in-repo at `web/public/icons/lionidas-avatar-dark-512.png` — usable directly via relative link).
- Current README content (read 2026-09-27): M0 stub — "Status: M0 (scaffold)", 55 lines, Setup/Quick start/Checks/Design invariants/License only.
- Verified current product surface (2026-09-27): 17 pages (overview, suites, wall, runs, baselines, flakes, templates, screens, env, monitoring, users, forge, guide, matrix, drive, run detail, test cases/login); feature docs for sweep/ci/inspect-mode/location/tap-overlay; ADR-0001; 1004 tests; CI green.
- Core capabilities landed this arc (verified): screen registry + YAML-first ScreenDocPanel, app-level login procedure, managed env vars (global/app/plan scopes), variant matrix + batch stamping, device wall, forge (mitmproxy network presets/scenarios), flaky sidelining, evidence/artifact store, Jira integration, roles (operator/agent/viewer), JUnit CLI.

## Exploration

### Header structure (adapted from the screenshot)

```
<p align="center"><img mascot 160px></p>
<h1 align="center">Lionidas</h1>
<p align="center">tagline: The E2E testing control dashboard — your app, proven.</p>
<p align="center">badges: CI · tests 1004 · license MIT · node 24 · engine: Alloy</p>
<p align="center">nav: Setup · What it does · Concepts · Screens & Login · Env · CI · Architecture · Docs</p>
<hr>
```

Badges: shields.io static badges (no fake numbers — `tests 1004` is real today; a `CI passing` badge can point at the real workflow). No invented stars/downloads/discord.

### Body sections (thorough, honest, current)

1. **What Lionidas does** — one shared control surface for E2E UI testing of iOS apps: device wall, run orchestration, screen registry, login procedures, env-seeded runs, verdicts + evidence.
2. **How it works** — the four nouns (suites/templates, screens, runs, forge) + Alloy execution engine, engine-neutral seam.
3. **Feature tour** — table mapping each nav page to one line of what it's for.
4. **The YAML grammar** — testcase shape, ensure login/ensure logout, screen registration, env refs `${env.*}`.
5. **Setup** (keep, still accurate) / **Quick start** / **Checks**.
6. **CI mode** — CLI, exit-code contract, JUnit link to docs/features/ci.md.
7. **Design invariants** (keep — still true).
8. **Docs map** — links to docs/features/*, docs/adr/*, plans/.
9. **License**.

### Open choices

- Mascot size: 160px (d2 screenshot vibe) vs 120px (restraint). Propose 160px.
- Status line: drop "M0 scaffold" (stale — product is well past M0; PLAN.md status language stays where it lives).
- Tagline: keep the existing "Your app. Proven." (it survived the rename; it's good).

## Open questions

None blocking — defaults chosen above are cosmetic; operator can adjust sizes/sections at review.

## Next step

Execute: write the new README.md on a fresh branch, verify relative mascot path renders (GitHub + local), commit, push, PR.
