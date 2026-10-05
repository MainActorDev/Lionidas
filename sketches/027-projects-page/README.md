# 027 — projects page

Admin-only registry of source repos (server shipped: `projects` +
`package_owner` tables, admin CRUD routes, token write-only, package claims —
commit 6518c88 on `feat/project-registry`).

One axis: **where editing happens**.

| dir | stance |
|---|---|
| `a-modal-editor/` | house table; row click opens a modal editor (cockpit-install idiom) |
| `b-inline-editor/` | house table; edit expands an inline editor under the row (suites/env idiom) |
| `c-split-detail/` | list left, persistent detail/editor panel right — package claims managed in the panel |

All on the round's shared tokens. Field set everywhere: name, repo url
(required), local path (optional), default branch, auth token (write-only,
blank keeps). Claims: A/B manage claims from the package picker row; C owns
them in the detail panel.

## Notes

- Nav: a `projects` item under **system**, rendered only for admins (App.vue
  holds `me.role`).
- Empty state: `no projects yet — + project registers a repo`.
- Delete confirm names the released claims.

Brainstorm: `brainstorm/20261005T071623Z-project-repo-registry.md` · plan +
review: `plans/`/`reviews/` 092500Z pair.
