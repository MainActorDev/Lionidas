# Phase 4 — Factory migration of the overview page (/)

- Source prompt: “I think I want the ‘/’ overview page first.” (after the 040 full-shadcn demo was rejected: “the 040 demo is ugly. let's keep the scoped.”)
- Created: 2026-10-15T14:53:21Z
- Status: Exploring

## Goal and context

Migrate the existing `/` overview — the front door — into the approved Factory design language (scoped CSS + selective shadcn primitives), and extend the self-hosted visual/a11y harness to cover it (it is already in `ROUTES`; baselines regenerate in the same reviewed commit). The page's job is unchanged: answer **is this build safe, and what needs eyes** at a glance, with run-all one click away.

User-confirmed this turn:
- Overview is the Phase 4 target (pulling it ahead of `/settings` in the ranked order).
- Scoped CSS stays the composition language; 040's full-shadcn restyle is rejected.

Standing constraints (recorded, not new):
- Factory dark tokens (`#101010`/`#1d1a18`/`#3d3a39`, Geist/Geist Mono, weight ≤500, status-only orange/green, no shadows). Shell (sidebar/topbar) untouched.
- Every phase runs brainstorm → plan → review → implement.

## Current page facts (code, verified this turn)

`web/src/pages/OverviewPage.vue` (269 lines): verdict word + sub-line, 6-cell coverage strip, requires-attention list (kind + case + tag → run/case deep link), latest-runs list (8 rows, → run detail), plan chips with run actions, `run all cases` header action, live refresh via `useLiveEvents` on `run.started`/`run.finished`, legacy `/?watch=` forwarding to /devices. Data: `GET /api/overview` (health/attention/coverage/latestRuns), `GET /api/plans`.

Layout realities found in the shipped light baseline review: the 6-column strip goes 3+3 on mobile; `latest runs` collapses to time+status at 375px; attention rows are one line with ellipsized names.

## Exploration — what Factory migration means here

The page already reads Factory-dark, but it predates the ledger/status compositional language: the verdict block is pre-ledger vocabulary (bold display word + chips), while `/audit` and `/status` established tighter structures (hairline bands, mono sub-lines, dotted states, day-grouped rows). Options for the Factory pass:

1. **Ledger-voice overview (proposal).** Re-express the same content in the established migrated-page idioms: verdict as a status band (word + mono sub-line + counts, like `/status`'s band), coverage strip kept but tightened to mono numbers over caption labels, attention + latest runs as hairline row lists (audit-row grammar: mono metadata left, status right), plan chips above. Strongest consistency with the two migrated pages; the verdict stays the dominant element.
2. **Verdict-hero overview.** Keep a large display verdict (current feel), restyle surrounding lists only. Least churn; weakest consistency with the migrated language.
3. **Two-band overview.** Status band (like 1) plus a second "coverage" band; lists below. More symmetric; risks duplicating the strip's content.

Trade-off to keep in view: the verdict's current scale (72px display word) is pre-Factory-typography; `/status`'s 17px band word is the migrated idiom. Whether the front door keeps a hero-scale answer or adopts band-scale is a real design choice — it changes the page's emotional register, not just its skin.

## Open questions

1. Verdict scale: keep a display-scale answer word (hero) or adopt the migrated band-scale (17px word + mono sub-line)?
2. Do plan chips stay as chips above the strip, or move into the header actions row?

Both are answerable by sketch variants rather than questions alone (house rule): render both scales in the variant set and pick.

## Next step

Sketch 2–3 Factory variants of the overview (same data, same actions, scoped-CSS composition), serve them, get the pick — then plan → review → implement with the QA gate, regenerating `/` baselines in the same commit.
