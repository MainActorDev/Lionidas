# 028 — settings page

New admin surface that takes over **project auth tokens** from the projects
editor (user direction 2026-10-05: tokens live in an independent Settings
page "we can use for other things too") and shows the storage locations.
Content today: per-project credentials (write-only: replace/clear, never
display) + storage (repos workspace, packages dir — read-only, env-derived).

One axis: **page shape**.

| dir | stance |
|---|---|
| `a-sectioned/` | stacked section blocks — credentials, storage, … each its own card |
| `b-single-card/` | one dense card with in-card section heads |
| `c-nav-anchored/` | left anchor nav (guide-page rhythm) — built for many future sections |

All real tokens. Token interactions everywhere: replace… (writes, never
shows), clear (danger), add… for tokenless projects.
