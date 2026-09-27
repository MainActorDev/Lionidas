## Variant: D2 — Hybrid UX on real Axiom tokens (d-hybrid-ux re-themed)

### Design stance
The D interaction model (scope sections + gaps strip + effective mode), rebuilt on the actual
design system: shared `../tokens.css` (verbatim from `web/src/styles/tokens.css`), the house
list idiom, PageHeader anatomy, and shared classes — so what you see is what EnvPage.vue will be.

### Token/class fidelity
- Colors/sizes: every value from `tokens.css` (`--color-*`, `--text-*`, `--s-*`, `--r-sm`,
  `--t`, `--font-mono`) — zero ad-hoc hex, zero ad-hoc px for system roles
- Page header: the two-row PageHeader anatomy (18px bold title + actions right; 13px desc +
  status syms over a hairline rule) — never a hand-rolled header
- Lists: the su-thead/a2-thead idiom — sticky uppercase 10px/steel thead, hairline
  `border-bottom: var(--color-iron)` rows, 44px min-height, graphite hover, actions
  right-aligned and named for what they do (`edit`, `delete`)
- Buttons: the shared `.btn` / `.btn-primary` / `.btn-sm` rules (2px corners, iron borders,
  ember fill for the ONE primary action)
- Insets: boxed carbon panels ONLY for insets (gaps strip, inline add, modal) — never for
  list items
- Ember used sparingly: gaps strip left-border + missing label, `ovr` badges, effective-mode
  source override, primary buttons

### Interaction model (unchanged from D)
Gaps strip (missing keys, one-click draft) · collapsed scope sections with counts · search
across all scopes · effective view (app + optional plan → resolved list, source badged) ·
blank-keeps-secret editing · usage badges on in-use keys

### Trade-offs
Same as D plus: none added — this is the build-fidelity version, not a new direction.

### Best for
The pick. This is D as it will actually ship.
