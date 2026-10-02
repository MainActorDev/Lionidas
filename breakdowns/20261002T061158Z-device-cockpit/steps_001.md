# Step 1 — Web test infra + reusable containers (WatcherPanel, SideDrawer)

- **Status:** Ready
- **Plan:** `plans/20261002T061158Z-device-cockpit-plan.md` rev 2 (Ready), Stage S1, condition 1; review F1 (vitest + @vue/test-utils in web)
- **Repo:** `feat/device-cockpit` @ `1cb422f`
- **Depends on:** nothing

## Outcome

`pnpm -C web test` exists and passes; `WatcherPanel.vue` + `SideDrawer.vue` land in `web/src/components/shared/` with mount tests. No page consumes them yet.

## Implementation

### 1a. Test infra (FIRST commit — F1)

```bash
cd web && pnpm add -D vitest @vue/test-utils happy-dom
```
- `web/package.json` scripts gain `"test": "vitest run"`.
- `vitest.config.ts`: environment happy-dom (the crucible skill's vitest conventions live server-side; web gets the minimal mirror — no parallelism tweaks needed for pure mount tests).
- Probe test (`src/components/__tests__/smoke.test.ts`): mounts a trivial `<div>{{ 1+1 }}</div>` component, asserts text — proves the chain.

### 1b. `WatcherPanel.vue` — the reusable tabbed rail (from the locked sketch's .rail markup)

Props/model (component API is the deliverable):
```ts
// tabs: [{ id: 'watch' | string, label: string }]
// panes render via slots: <WatcherPanel :tabs :active @switch> <template #watch>…</template> </WatcherPanel>
// sections inside a pane are ALSO reusable: export WatcherSection
// (h3 + collapse toggle + meta slot + body slot) and WatcherSteps
// (rows: {text, state: 'done'|'live'|'todo'}[], optional meter {value,max})
// and LogTail (rows: {ts, text, kind?: 'hit'|'err'}[]) — the sketch's
// .sect/.s/.logtail classes, verbatim, tokens.css vars only.
```
- Styling: the sketch's CSS (`.railtabs`, `.rtab`, `.sect`, `.s.done/.live/.todo` with ✓/◆/◌ ::before, `.meter`, `.logtail`) moved into scoped styles; NO global selectors (the layout.css `.app` collision lesson).
- `defineExpose` nothing; emits `switch(tabId)`.

### 1c. `SideDrawer.vue` — left slide-over

```ts
// props: open: boolean; title: string — emits close
// v-if slot content, translateX transition, @media (prefers-reduced-motion) → none
// positioned absolute inset-y left, width prop (default 264px), z-index slot-friendly
```

## Verification (TDD)

Tests in `web/src/components/__tests__/`:
- WatcherPanel: renders tabs, `switch` emitted on click, active tab ember-underlined (class assert); WatcherSection collapses on header click; WatcherSteps renders ✓/◆/◌ states + meter width; LogTail renders rows + kind classes.
- SideDrawer: closed → content absent from DOM (v-if), open → present; title rendered; close emitted from the ✕ button.
- All against the Axiom token classes (assert class names, not computed colors — DOM measurement over innerText).

```bash
cd web && pnpm test && pnpm build
```

## Completion gate

- [ ] `pnpm -C web test` green (smoke + panel + drawer); build clean
- [ ] Components token-pure (no hex literals — grep the SFCs)
- [ ] Commit(s) pushed
