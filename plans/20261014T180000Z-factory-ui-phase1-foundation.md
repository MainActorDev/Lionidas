# Lionidas UI Revamp — Phase 1: Factory Design System Foundation

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Replace the Axiom visual language with the approved **factory-sidebar (all-dark)** system across the shared shell and global styles, without changing any page's behavior or data contracts.

**Architecture:** A token-sheet swap + shell rebuild. Phase 1 deliberately touches only `web/src/styles/*.css` (tokens remapped to Factory values), `App.vue` (shell: sidebar + topbar + mobile drawer), and `index.html` (Geist fonts). Pages keep their current DOM and classes — the ~2,670 `var(--…)` references across 64 styled files resolve to Factory values through the existing token names, so every page re-skins atomically without per-page edits. Per-page structural migration (layout/composition to Factory idioms) is Phase 2+, page-by-page in the ranked order.

**Tech Stack:** Vue 3 + Vite (existing), CSS custom properties (no Tailwind/shadcn yet — this phase is pure CSS; shadcn-vue integration is deferred to a later phase and will be planned separately).

---

## Locked design contract (source: round 036, user-approved)

From `sketches/036-lionidas-visual-direction/factory-sidebar/index.html` + user corrections (all four rounds):

| Decision | Value |
|---|---|
| Canvas | `#101010` obsidian |
| Raised surface | `#1d1a18` carbon lift (cards, active nav, buttons, hover rows) |
| Hairline border | `#3d3a39` ash stroke (dividers, ghost outlines); `#1d1a18` for inner tile dividers |
| Text ramp | `#eeeeee` bone primary / `#b8b3b0` pale-stone labels / `#8a8380` warm-granite muted |
| Status accents | `#ee6018` signal-orange, `#a0ca92` metric-green — **status/data only, never fills** |
| **Rejected** | white/chalk bright fills (buttons AND hero cards), yellow/acid-lime, bold weights 600+, drop shadows |
| Type | Geist 400 everywhere (500 sparingly); Geist Mono 12px uppercase `-0.24px` for labels/nav groups/status |
| Display sizes | h1 36px `-1.12px` lh 1.1; metric values 32px `-0.8px`; body 14px lh 1.5 |
| Radii | 3px buttons/nav, 10px cards |
| Motion | `0.18s cubic-bezier(0.4,0,0.2,1)` on color/border/bg only |
| Navigation | **Sidebar** (user-preferred) — grouped, mono uppercase labels; ≤760px becomes an off-canvas drawer with hamburger + scrim + Esc |
| Brightness rule | No element background lighter than `rgb(200,200,200)` anywhere |

## Constraints

- Zero behavior/data changes: no `fetch` calls, routes, stores, or template logic edits in Phase 1 (except the shell's own drawer mechanics).
- `pnpm run check` and `pnpm run build` must pass; existing vitest suites must stay green (they mount pages with stubs — token swaps don't affect them, but App.vue shell tests exist: `web/src/pages/__tests__/StatusPage.test.ts`, agent tests mount full App).
- Geist is loaded via Google Fonts CDN in dev; a later task may self-host if the user wants offline builds — flagged, not silently decided.
- Concurrent edits exist in `server/` (another worker) — do not touch.

---

### Task 1: Add Geist fonts to index.html

**Files:**
- Modify: `web/index.html`

**Steps:**
1. Add `<link rel="preconnect" href="https://fonts.googleapis.com">`, `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>`, and `<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500&family=Geist+Mono:wght@400&display=swap" rel="stylesheet">` to `<head>`.
2. Run: `pnpm --filter web dev` → confirm the app loads and DevTools shows Geist resolved (no fallback-only rendering).

### Task 2: Remap tokens.css to Factory values (keep token NAMES)

**Files:**
- Modify: `web/src/styles/tokens.css` (values only; names like `--color-void` stay so all 2,670 references keep resolving)

**Mapping (Axiom name → Factory value):**

```
--color-void:#101010      (canvas)         --color-carbon:#1d1a18  (raised)
--color-graphite:#1d1a18  (inner divider)  --color-iron:#3d3a39    (hairline)
--color-slate:#4d4947     (mid)            --color-pewter:#3d3a39
--color-steel:#8a8380     (muted)          --color-ash:#b8b3b0     (labels)
--color-fog:#b8b3b0                        --color-chalk:#eeeeee   (light TEXT only)
--color-paper:#eeeeee     (primary text)   --color-ember:#ee6018   (status only)
--color-ok:#a0ca92  --color-warn:#b8b3b0  --color-err:#ee6018
--font-mono:'Geist Mono',ui-monospace,...   --font-sans:'Geist',...
--text-caption:12px --text-body:14px --text-label:13px
--text-heading-sm:24px --text-heading:36px(→36px) --r-sm:3px --r:3px
--weight-bold:500  (Factory caps at 500 — bold reads as 500)
--t:0.18s cubic-bezier(0.4,0,0.2,1)
```

3. Verify: `pnpm --filter web build` passes; spot-check the login page — mono text now renders Geist Mono, ember accents now orange-on-dark.

### Task 3: Rebuild the shell (App.vue + layout.css)

**Files:**
- Modify: `web/src/App.vue` (template: sidebar groups → mono labels; add hamburger `#openNav`, scrim, Esc handling; keep all RBAC `visibleGroups` logic untouched)
- Modify: `web/src/styles/layout.css` (Factory shell styles: 224px sidebar, ash right border, carbon active states, ≤760px off-canvas drawer + scrim + sticky topbar)

**Steps:**
1. Port the shell markup/CSS from `sketches/036-lionidas-visual-direction/factory-sidebar/index.html` (sidebar, topbar, brand with pulse dot, nav groups, railfoot) into App.vue/layout.css, wiring `visibleGroups`/`isActive`/`signOut`/CmdPalette exactly as today.
2. Mobile: hamburger toggles `.sidebar.open`, scrim click + Esc close, `aria-expanded`/focus management — mirror the mockup's JS.
3. Keep `.main` full-width (devices-page convention: no page-level max-width).
4. `⌘K` badge stays in topbar (chrome text `#b8b3b0`).

### Task 4: Update global components.css classes

**Files:**
- Modify: `web/src/styles/components.css` (`.btn`→3px radius/carbon fill/bone text; `.card`→carbon+ash border 10px; `.section-label`→Geist Mono 12px uppercase; `.status`/`.chip`→status-only colors; `.a2-*` list chrome → hairline rows on `#101010`, carbon insets)

Keep every class name — only values change. Run `rg 'font-weight:\s*(600|700|bold)' web/src/styles/` → should return only the remapped `--weight-bold:500` usage, no literals.

### Task 5: Verify — build, tests, responsive drill, brightness scan

1. `pnpm run check` && `pnpm run build` — both green.
2. `pnpm --filter web test` — vitest suites green (App mount stubs unaffected by style values).
3. Browser drill (dev server, real navigation at 375/768/1024/1440): no horizontal scroll; sidebar → drawer at ≤760px; every nav group reachable; ⌘K palette opens; sign-out works; **brightness scan**: `Array.from(document.querySelectorAll('*')).filter(el => rgb(bg) all >200).length === 0`.
4. Screenshot overview/login/runs at all four widths into `~/.hermes/cache/scratch/lionidas-visual-drill/phase1/` for the user's visual sign-off.

### Task 6: User sign-off gate

Present screenshots + dev server. **Phase 1 is done only when the user approves the shell visually.** Then Phase 2 (first page pilot: `/tickets/:key` matrix, or `/audit` if no ticket) gets its own plan.

---

## Risks

- **Ember→orange on 314 sites**: some Axiom usages were decorative (active nav borders); as a status-only accent this is *correct* per Factory, but pages may look quieter — acceptable in Phase 1, revisited per-page in Phase 2.
- **`--weight-bold:500` remap** changes emphasis everywhere at once — intentional (Factory voice), but dense pages (test cases) may need per-page review in Phase 2.
- Google Fonts CDN in `index.html` is a network dependency — flagged for a self-hosting decision later.
- App.vue has concurrent-work risk (untracked server files from another worker exist); only touch `web/`.
