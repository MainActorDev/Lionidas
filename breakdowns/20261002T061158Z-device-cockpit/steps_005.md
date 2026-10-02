# Step 5 — Deletion, routing, visual verification, PR

- **Status:** Ready
- **Plan:** rev 2, Stage S5, conditions 8, 9; review F2 (sidebar survives), F6 (router)
- **Repo:** Step 4 head · **Depends on:** Steps 1–4 gated green

## Outcome

`/drive` + DrivePage deleted; `/cockpit` is the manual-control home; five-state visual verification recorded; PR opened.

## Implementation

### 5a. Deletion (F2 scope — exactly this, no more)

- Delete `web/src/pages/DrivePage.vue`; remove its import + `/drive` route from `router.ts`.
- **DeviceSidebar.vue SURVIVES** (WallPage + DeviceRail mount it). Do NOT touch it.
- Nav: wherever `/drive` appears in nav links (grep `drive` in web/src — App.vue/nav component), point it to `/cockpit`.
- Optional one-liner (allowed): WallPage sidebar gains a link `open in cockpit → /cockpit?udid=` — only if trivially mountable; skip if it touches DeviceSidebar internals.

### 5b. Router final state

`/cockpit` `meta: { title: 'cockpit' }`; no redirect from `/drive` (internal tool; stale muscle memory gets a clean 404 → nav).

### 5c. Five-state visual verification (spec-vs-build)

Boot stack + a booted sim; screenshot at 1280×800 each:
1. **no-session** — stage placeholder, idle switcher sublabels
2. **session-live** — take control, session chip, watchdog ticking
3. **chat-tab** — one real exchange with the context prepend visible
4. **env-drawer** — open over the stage
5. **session-lost** — restart server mid-session → banner

Compare against `sketches/022-cockpit-final2-single-switch/` (side-by-side in the PR body or a docs screenshot dir — record where). DOM-measure the bezel centering + rail width (never innerText alone).

### 5d. Closeout gates + PR

- `pnpm -C web test` + `pnpm -C web build` + `pnpm -C server test` (untouched-green) + `pnpm -C cli test`
- Screenshots + drill notes in PR body; link the locked sketch as the spec.
- Push; open PR `feat/device-cockpit` → `main` (create-only; operator merges).

## Completion gate

- [ ] `/drive` gone (404), `/cockpit` live, DeviceSidebar untouched, wall page renders green
- [ ] Five screenshots recorded; DOM measurements pass; all gates green
- [ ] PR opened with spec linkage
