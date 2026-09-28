# 021 — network page revamp (3 directions)

Grounded in the real DB (2026-09-28): 3 scenarios (countries-sg/my/empty), 1 preset each, all immutable-after-use, 62/21/21 stamped runs, 12,779 traffic rows. All variants on shared `../tokens.css` (verbatim Axiom). Served: `http://127.0.0.1:8791/021-network-page/<variant>/`

Settled before this round: traffic stays on the page (subordinate feed); references move to stable ids (names = labels); agent authoring is CLOSE — the scenario document matters.

## Variants

| | A — workbench | B — tabs | C — document |
|---|---|---|---|
| Stance | scenarios get a two-pane workbench (list + editor) | split by concern into tabs; control strip always up | the YAML document IS the scenario editor |
| Scenario mgmt depth | ★★★ members table, duplicate, used-by, sha-diff marker | ★★ inline expansion (today's pattern, cleaned) | ★★★★ form⇄doc two-way like screens/cases |
| Agent fit | medium (structure explicit) | low | ★★★★★ the agent reads/writes exactly this |
| Build size | medium | small | large (grammar + validator + panel) |
| Risk to existing cases | low | lowest | medium (needs id-keyed refs first) |

- a-workbench/ — `http://127.0.0.1:8791/021-network-page/a-workbench/`
- b-tabs/ — `http://127.0.0.1:8791/021-network-page/b-tabs/`
- c-document/ — `http://127.0.0.1:8791/021-network-page/c-document/`

## Recommendation

**C** (document-first), with A's workbench affordances absorbed as the "form" side of the form⇄doc toggle: the agent direction is close (user-confirmed), screens/cases already set the pattern, and the id-keyed reference fix makes the document honest about pins. B is the safe fallback if the build budget says later.

## Shared design elements (all variants)

- Persistent control strip: proxy state + sims routing + global mode — never buried.
- `used` chip + `changed since last play` marker (sha diff vs stamped runs).
- Traffic = capped live feed with search; preset id surfacing on matched rows.
- Real numbers, real paths, real ids (no invented data).
