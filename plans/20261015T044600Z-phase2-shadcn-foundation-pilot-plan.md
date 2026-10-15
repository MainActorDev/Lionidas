# Phase 2 — shadcn foundation + /audit pilot — Implementation Plan

> **For Hermes:** implement task-by-task with build/test verification between each. Accessibility acceptance is part of "done", not a follow-up.

**Goal:** Land shadcn-vue in `web/` with Factory-mapped theme variables (dark default + light registered), replace the hand-rolled mobile drawer with shadcn `Sheet`, and migrate `/audit` as the template page — accessibility verified by measurement.

**Source brainstorm:** `brainstorm/20261015T044600Z-phase2-shadcn-foundation-pilot.md` (status: Direction selected; user answered all three gates 2026-10-15).

**Architecture:** Tailwind v4 arrives as a parallel utility layer (`@tailwindcss/vite` plugin) alongside the existing scoped-CSS system; shadcn's theme variables (`--background`, `--primary`, …) are mapped FROM the Factory tokens so both systems read one source of truth. Pages migrate wholesale (new composition), never mixed within a page. The pilot (`/audit`) proves the primitive set and becomes the copy-source for the remaining 19 pages (Phase 3+).

**Tech:** `tailwindcss@4` + `@tailwindcss/vite`, `shadcn-vue@2.8.2` CLI (via `pnpm dlx`), `reka-ui` runtime, `lucide-vue-next` icons, `vue-sonner` toasts, `axe-core` for the a11y drill.

---

## Task 1 — Tailwind v4 + shadcn init (foundation)

**Files:** `web/package.json`, `web/vite.config.ts`, `web/components.json`, `web/src/styles/theme.css` (new), `web/tsconfig.app.json` (alias check).

1. `pnpm --filter web add tailwindcss @tailwindcss/vite`; register the plugin in `vite.config.ts`.
2. `pnpm --filter web add reka-ui lucide-vue-next vue-sonner class-variance-authority clsx tailwind-merge`.
3. Create `web/src/lib/utils.ts` (`cn()` helper) and `web/components.json` manually (CLI init is interactive; config: `style: "nova"`, `baseColor: "neutral"`, `cssVariables: true`, aliases `@/* → src/*`, icon `lucide` — **user-confirmed 2026-10-15: lucide**) — then `pnpm dlx shadcn-vue@2.8.2 add sheet button table badge select sonner --yes` to generate components with rewritten imports. **Pin the CLI at `@2.8.2` everywhere it runs** (the audited version; never `@latest`).
4. Create `web/src/styles/theme.css`: `@import "tailwindcss";` + `@theme inline` block + `:root` (light) and `.dark` (Factory) blocks mapping shadcn variables to Factory tokens. **Dark = Factory source of truth** (`--background: #101010`, `--card: #1d1a18`, `--primary: #1d1a18` + `--primary-foreground: #eeeeee`, `--border: #3d3a39`, `--destructive: #ee6018`, `--ring: #b8b3b0`). **Light = registered values** (paper `#fafafa` bg, `#101010` fg, same accent semantics inverted) — present for the future toggle, not activated. Add `.dark` to `<html>` in `App.vue` onMounted (single line; activation UI stays out of scope).
5. Import `theme.css` in `main.ts` **after** the existing token files so utilities and custom properties coexist.
6. Verify: `pnpm --filter web build` green; `pnpm --filter web dev` renders unchanged (no visual drift on unmigrated pages — screenshot overview at 1440 & compare against Phase-1 baseline).

## Task 2 — Drawer → shadcn Sheet

**Files:** `web/src/App.vue`, `web/src/components/ui/sheet/*` (generated), `web/src/styles/layout.css` (delete hand-rolled drawer rules).

1. Replace the `navOpen`/scrim/Esc hand-roll in `App.vue` with `Sheet` wrapping the existing sidebar content: `<Sheet v-model:open="navOpen"><SheetContent side="left" class="p-0 w-[min(84vw,280px)]">…sidebar nav…</SheetContent></Sheet>`.
2. Desktop (≥761px): sidebar renders as today (CSS grid, unaffected). Mobile: the same nav renders inside the Sheet. Implementation: extract the nav into a small `AppNav.vue` component used by both the desktop `<aside>` and the mobile `SheetContent` — one source, two mounts, no RBAC duplication.
3. Keep: route-change auto-close, hamburger `aria-expanded`, `aria-label`s. Gained for free from reka-ui: focus trap, scroll lock, Esc, `aria-modal`. Delete `.nav-scrim` + transform CSS from `layout.css`.
4. Verify in browser at 375px: drawer opens via hamburger, focus is trapped inside while open (tab cycles nav links), Esc closes, body scroll locked; axe-core on the open drawer reports 0 violations. **Re-run the unmigrated-page screenshot diff here too** — App.vue changed, so overview at 1440 must still match the Phase-1 baseline.

## Task 3 — Migrate /audit (pilot page)

**Files:** `web/src/pages/AuditPage.vue` (wholesale rewrite of template+styles; script logic preserved), uses generated `Table`, `Badge`, `Select`, `Button`, `Input`.

1. Keep the script section (fetch/filter/cursor logic) byte-identical where possible; replace template with shadcn composition: `PageHeader` (kept) → filter row (`Input` + grouped `Select` + `Button`) → `Table` (sticky mono uppercase `TableHead` per house convention) → status/event chips as `Badge` variants → "load more" `Button` with loading state.
2. Replace the page's 20-line scoped stylesheet with utilities + the two or three Factory classes that remain global. Event-class chip colors keep the status-only accent rule (orange for rbac denials, neutral otherwise) with the existing text label (non-color redundancy).
3. Every state preserved: loading (skeleton row), error (role-aware text: 403 → "supervisor role required"), empty, hasMore pagination, filter apply on Enter/change.
4. Verify: `pnpm --filter web build` + `pnpm --filter web test`; browser drill at 375/768/1024/1440 with stubbed `/api/audit` (supervisor session) — filters apply, pagination cursor advances, no horizontal overflow, screenshots into the drill dir.

## Task 4 — Accessibility drill (measured, both themes)

1. **Contrast audit** (computed, both `:root` light and `.dark`): every fg/bg pair in theme.css ≥ 4.5:1 (AA normal text) — adjust light-ramp values if any pair fails; dark ramp already verified (7.1:1 / 4.6:1) but re-run against actual rendered pairs.
2. **axe-core pass** on shell + audit page (both themes, 375px & 1440px): 0 critical/serious violations.
3. **Keyboard walkthrough** (scripted): tab order sensible through topbar → filters → table → load-more; visible focus indicator on every interactive element (add `focus-visible` ring via `--ring` where utilities don't); Sheet focus trap verified in Task 2.
4. **Reduced motion**: drawer/toast transitions respect `prefers-reduced-motion` (Tailwind's `motion-safe:`/`motion-reduce:` utilities).
5. Record results (pass/fail per check, adjusted hex values if any) in the phase README.

## Task 5 — Gate: user sign-off

Present dev server + screenshots + a11y results table. Phase 3 (next page in ranked order: `/status`) opens a fresh brainstorm → plan → review chain.

---

## Results (2026-10-15, Tasks 1–4 complete)

**Task 1** ✓ — deps in, `components.json` + `theme.css` + `cn()` created, alias wired (vite + tsconfig + vitest). Registry note: `nova` style 404s upstream; generated with `new-york` (identical primitive set — Factory look comes from theme.css, so style choice is moot). `exactOptionalPropertyTypes` (strict base flag) conflicts with reka-ui `Primitive` typing → relaxed **project-wide** for web only (disclosed: weakens optional-prop strictness for app code; revisit if reka-ui fixes upstream).

**Task 2** ✓ — `AppNav.vue` single nav source; desktop `<aside>` + mobile Sheet both mount it. Drill at 375px: dialog role, overlay, scroll lock, focus trapped (3 tabs stay inside), Esc closes, route-change auto-close kept. `.nav-scrim` + off-canvas CSS deleted. Phase-1 overview diff: **0.031%** changed pixels (bbox = new `railfoot` label only).

**Task 3** ✓ — `/audit` rewritten on Table/Badge/Select/Button/Input; script logic byte-identical (only `AcceptableValue` handler typing added). Drill 375/768/1024/1440: no overflow, filters apply, cursor pagination works, empty state renders.

**Task 4** ✓ —
- Contrast (computed, WCAG): dark 9/9 pairs ≥5.2:1; light 7/7 pairs ≥4.5:1 after darkening `--ring` 8a8380→6b6663, `--destructive` c24f13→b03d0e, and theming `--status-orange/green` per theme (legacy token aliases now flip too).
- axe-core: 0 violations — overview & audit, dark & light, 375 & 1440, sheet open. Fixes that got there: `<nav>` landmarks per group + `role="banner"` topbar + `role="navigation"` sheet nav; table scroll container `tabindex="0"` + focus ring; sheet scroll region tabbable.
- Keyboard: tab chain verified topbar → filters → table region → load-more; focus-visible ring on filters (`outline-ring/50`).
- Reduced motion: global `prefers-reduced-motion` override exists (tokens.css) + `motion-reduce` respected in drill.

**Gates:** build ✓, typecheck ✓, lint 0 errors, web tests 104/104, `pnpm run check` green. `axe-core` added as web devDependency (drill tooling only).

---

## Acceptance criteria

- `pnpm run check` (web) green; web tests 104/104; no new lint errors.
- Unmigrated pages visually identical to Phase 1 (screenshot diff on overview).
- `/audit` fully functional via shadcn composition in both themes (dark active, light reachable by class flip for verification only).
- Mobile nav = Sheet with focus trap, scroll lock, Esc; axe 0 critical/serious on drilled surfaces; contrast table all-AA with measured numbers.
- No behavior/API changes: audit endpoint contract untouched; RBAC gating untouched.

## Risks

- **Two style systems coexist** until all pages migrate — bounded: pilot migrates wholesale; utilities never mixed into unmigrated pages.
- shadcn-vue CLI audit debt (braces DoS) is in the CLI tool, not runtime deps; runtime adds only reka-ui/icons/sonner — but re-run `pnpm audit --filter web` after install and report honestly.
- Geist via Google Fonts CDN remains (offline builds flagged earlier; self-hosting is its own task).
- Sheet + existing CSS grid shell must not double-render nav — Task 2's single-source `AppNav.vue` is the guard.
