# 039 — styling mechanism demo (scoped CSS vs Tailwind utilities)

Not a design round — a **mechanism** demo. The question: what would the migrated pages look like with no scoped CSS at all? One page (the just-shipped status board, three representative tiles), one Factory token sheet, three styling mechanisms, zero visual difference by design:

- **A · scoped CSS** — what `StatusBoardPage.vue` ships today. Rules live in the SFC's `<style scoped>`; template stays declarative (`class="a-tile"`).
- **B · pure Tailwind utilities** — every rule inlined into the template (`flex min-w-0 min-h-[135px] flex-col gap-[7px] …`). Zero scoped CSS. Reads dense; a 3-tile row is ~20 utility tokens, and the real page repeats them per dynamic state.
- **C · utilities + small shared components** — the repeated unit (a status tile) becomes one component class, built with utilities via `@apply`/cva — exactly how the generated `ui/` primitives (Button, Badge) are authored. Template reads like A; rules are Tailwind.

## Trade-offs (authoring, not looks)

| | A scoped | B pure utilities | C utilities + components |
|---|---|---|---|
| Template readability | high | low (dense strings) | high |
| Style reuse across pages | low (per-page dialects — the drift risk) | none without copy-paste | high (shared primitives) |
| Token enforcement | via `var()` refs | via theme vars (equivalent) | via theme vars + one definition site |
| Diff noise on restyle | small (CSS block) | large (every template) | small (component) |
| Tooling | plain CSS | full Tailwind lint/purge | same as B |
| Fidelity to picked mockups | near 1:1 | needs translation pass | needs translation pass |

The demo page itself is served from the repo sketch server on **8794** — view source of each section to feel the authoring difference. The only hand CSS anywhere is the token sheet itself, which both systems read.

**Position:** B (no abstraction) is unlikely to be what anyone wants for repeated units like ledger rows or tiles; C is the credible "no scoped CSS" endpoint — scoped CSS replaced by *shared Tailwind-built components*, not by inline strings. A→C is a per-page mechanical migration with baseline regeneration per route.
