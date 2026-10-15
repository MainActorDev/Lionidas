# e2e — visual regression + a11y harness

Local-first QA gate (plan `plans/20261015T082000Z-uiux-qa-harness-stage1-plan.md`).
Self-hosted, no CI dependency, deterministic on any machine.

## Run

```bash
pnpm --filter web test:e2e          # build + preview + 10 tests (~10s)
```

Adds a route when Phase 3 migrates a page: append to `ROUTES` in `routes.ts`
(+ a `readySelector`), run `pnpm --filter web test:e2e -- --update-snapshots`,
commit baselines **in the same reviewed commit** as the page change.

## How it works

- `routes.ts` — THE swap point: route table + full pre-navigation API mocks
  with fixed timestamps (anchored to `2026-10-15T09:00:00Z`), `en-GB`/`UTC`
  pinned in config so renders are machine-independent. When Lionidas' own
  web engine lands, this file survives; only `visual.spec.ts` is rewritten.
- `visual.spec.ts` — per route × viewport [375,1440] × theme [dark,light]:
  1. **Pixel baseline** — `toHaveScreenshot` (fullPage) vs committed PNG.
  2. **Structural gate** — ledger rows must share uniform width; no
     horizontal overflow. Pixel diffs alone miss layout breaks that land
     under ratio budgets.
  3. **axe WCAG2 A/AA** — zero serious/critical violations.
- Baselines live in `__screenshots__/` (committed). Intentional visual
  change = regenerate + review, like code.

## Three pitfalls baked into the config (learned 2026-10-15, do not undo)

1. **`reuseExistingServer: false`** — a leftover `vite preview` from a stale
   dist makes every comparison stale-vs-stale: false greens.
2. **Inline assertion options** — Playwright silently ignores the config
   `expect.toHaveScreenshot` block when using `-c <path>` configs. Options
   are repeated inline in the spec. (Probe-verified.)
3. **`threshold: 0.05`, `maxDiffPixelRatio: 0.0005`** — defaults (0.2/–)
   swallow ≤51/255 color shifts entirely (a toolbar fill swap diffed as
   zero) and 0.2% ratio admits real layout breaks. Fixture rows also stay
   ≥14 with medium-length details: thin fixtures move too few pixels.

## Mutation-test evidence (run 2026-10-15)

| injected bug | result |
|---|---|
| rows lose `width:100%` (shrink-wrap) | 5/10 FAILED ✓ caught |
| search box fill → transparent | FAILED ✓ caught |
| baseline deleted | FAILED ✓ caught |
| clean source | 10/10 passed, stable ×3 |
