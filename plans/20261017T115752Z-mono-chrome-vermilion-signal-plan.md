# Mono chrome + vermilion signal — accent re-home plan

- Source: `brainstorm/20261017T112720Z-orange-accent-fit.md` (status: Approved)
- Decision log:
  - "I think I kind don't see that the orange accent color is fit in the whole app" (user, 2026-10-17)
  - "C" — the hue itself is the problem (user, 2026-10-17)
  - "Mono. failures/degraded not orange but some other color that you see fit" (user, 2026-10-17)
  - "Approved" — after seeing rendered previews of mono chrome + vermilion #e06f5d/#b04a3f on real screenshots (user, 2026-10-17)
- Status: Ready (awaiting human gate per workflow)

## Objective

Re-home the app accent: **interactive chrome goes monochrome** (bone on dark, graphite on light — the Linear/Vercel pattern) and **ember orange is retired**, its signal role passing to **vermilion** reserved for fail/degraded/live. Done when every page renders with the approved look and all gates pass.

## Verified facts

- Token contract already says status colors are "DATA/STATUS ONLY, never fills" (`web/src/styles/tokens.css:27-31`) — the sweep *restores* the contract; mono chrome is the new accent for interactive surfaces.
- Ember spread: 277 `var(--color-ember…)` references; 45 fill uses; ~195 text; ~112 border (grep 2026-10-17).
- Ember is themed in `web/src/styles/theme.css`: dark `#ee6018`/`#c24f13`, light `#b03d0e`/`#8a2f0b`. `--color-err` aliases the same vars (`tokens.css:35`).
- Contrast (computed 2026-10-17, WCAG): vermilion dark `#e06f5d` = 5.98/5.44/4.96 on canvas/carbon/tinted; light `#b04a3f` = 5.16/4.78 on `#fafafa`/`#f3f1ee`. All ≥4.5.
- No test/e2e file hardcodes the ember hexes (grep 2026-10-17).
- Approved preview images: `~/.hermes/cache/scratch/accent-preview/mono-signal-{dark,light}.png` (vision-verified: bone buttons, vermilion failure/degraded/live marks, sage ok, gold queued untouched).
- Base: `main` at `d93b388` (PR #53 merged), clean tree.

## Scope

**In:** `web/src` (tokens, theme, all 64 ember-referencing files incl. cockpit fullscreen + agent v1/v2 + shared components), `::selection`, focus rings, baselines, axe.

**Out:** server-side anything; gold `#d9b06a` (queued/warn) and sage `#a0ca92` (ok) — unchanged; new features; component restructuring (color-only sweep).

## Design decisions (traceable)

1. **Chrome accent token** — add `--color-accent` / `--color-accent-dim`, themed:
   - dark: `#d9d5cf` (bone fill/border/text) / dim `#b5b1ab`
   - light: `#2a2622` (graphite) / dim `#4a453f`
   - Contrast: bone-on-carbon ≈ 10.9:1, graphite-on-paper ≈ 12.4:1 (both directions pass as fill+text pairs).
   - *Rule amendment, user-approved:* Factory's "no bright/white fills" is refined to "no pure-white `#fff`/`#fff`-equivalent fills" — the approved preview shows low-chroma **bone** primary buttons (`#d9d5cf`, never `#fff`). Hairlines, weight ≤500, no shadows: unchanged.
2. **Signal re-home** — `--status-orange`/`--status-orange-dim` values become vermilion (dark `#e06f5d`/`#c05645`, light `#b04a3f`/`#8f3a31`). Token NAMES unchanged — `--color-ember`, `--color-err` inherit the new values with zero mechanical churn; comments updated to say "vermilion — fail/degraded/live".
3. **Classification rules** (deterministic, per use-site):
   - **CHROME → `--color-accent`**: button fills/borders/labels (primary + ghost), links, selected nav state, focus rings, hover/active states, `::selection`, caret/cursor, active chips/tabs, stop/abort **buttons**.
   - **SIGNAL → stays ember (= vermilion)**: failed/failed-count text & dots, degraded labels & dots, error text, live/running dots & "working" markers, zombie/timeout/backlog counts, attention marks.
   - A component with both (RunPanel: live dot + stop button) splits per rule — dot signal, button chrome.
4. **Inventory artifact** — before the sweep, generate `web/scripts/../docs`-free: commit `plans/assets/20261017T115752Z-ember-inventory.md` (grep-derived per-file/per-use line list, classified CHROME/SIGNAL via the rules) so the sweep is auditable line-by-line.

## Implementation stages (ordered)

1. **Tokens** — `theme.css`: re-value `--status-orange{,-dim}` both themes; add `--color-accent{,-dim}` both themes. `tokens.css`: comments; `::selection` → accent bg + canvas text. Verify visually on dev server.
2. **Inventory** — generate + commit the classified inventory (gate: zero UNCLASSIFIED lines remain).
3. **Sweep** — replace CHROME sites per inventory (`--color-ember…` → `--color-accent…`); SIGNAL sites untouched (already vermilion via tokens). One commit, mechanical, reviewable against the inventory.
4. **Gates** — `pnpm build`; vue-tsc 0; vitest full; e2e FULL baseline regen (every page changes) then green run; axe ≥4.5 all routes/themes; vision pass dark+light × overview/agent/status against the approved preview; cockpit spot-check.
5. **Docs + PR** — brainstorm/plan status flips; PR create-only (merge is human).

## Edge cases

- Focus rings that double as error markers (none known — inventory will surface any).
- Light-theme tinted surfaces (`#f3f1ee` cards): vermilion light 4.78:1 ✓; graphite accent on tinted ✓.
- Anti-aliasing/hover states referencing raw `#ee6018`/`#c24f13` instead of tokens — inventory greps raw hexes too and converts to tokens.
- Third-party CSS (reka/shadcn) — unaffected; they use shadcn vars.

## Acceptance

- No `#ee6018`/`#b03d0e`/`#c24f13` remain in `web/src` (inventory-driven).
- Buttons/links/selected/focus = mono bone/graphite on all pages; fail/degraded/live = vermilion; ok = sage; queued = gold.
- Full gates green (build, tsc, unit, 26 e2e + regen, axe); vision match vs approved preview; user eyeballs the dev server.
