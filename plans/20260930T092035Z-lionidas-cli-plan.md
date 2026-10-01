# Lionidas CLI — full command table, phased (plan)

- Source brainstorm: `brainstorm/20260930T092035Z-lionidas-cli.md` (status: Direction selected; Decisions log + Architecture sections)
- Status: Ready (rev 2 — review F1-F6 applied; review `reviews/20260930T092035Z-lionidas-cli-plan-review.md`)
- Created: 2026-09-30

## Decision log (provenance)

| # | Decision | Source |
|---|---|---|
| 1 | Full ~25-command table, delivered in 3 phases | operator, 2026-09-30 |
| 2 | Auth best practice = PAT; web-login reuse via browser approval flow (one click, no password re-entry); paste-from-settings for CI; both minting flows | operator, 2026-09-30 ("What is the best practice? Though if user already logged-in from the web, it should work" → approved both) |
| 3 | Workspace bin, **callable from anywhere** (global `lionidas` on PATH) | operator, 2026-09-30 ("Approved with a minor note") |
| 4 | Architecture per brainstorm's Architecture section (command/client/stack layers; server stays single writer; CLI never touches the DB) | operator, 2026-09-30 ("Please think the architecture carefully" → architecture presented → "4. Approved") |
| 5 | **Folder operations for test cases in scope** — `folder` group manages the case tree | operator, 2026-09-30 ("It should include the ability for foldering operations to manage test cases") |
| 6 | Command table as presented in chat 2026-09-30 (the full listing shown to the operator) — operator invoked the plan skill immediately after; treated as accepted unless a command contradicts an API shape (each binding is re-verified at build time by contract tests) | operator review of the table, 2026-09-30 |
| 7 | Interim auth (phase 0): `auth login --email/--password` stores the 12h session cookie; PAT lands in phase 1; client prefers Bearer when present | brainstorm architecture, uncontested |

## Objective and completion conditions

A `lionidas` CLI — one global command, callable from anywhere — that exposes every Lionidas operation as intention-level commands with `--json` everywhere, so a human or an AI agent can run the proven workflow (orient → ensure stack → author → run → verify → triage → clean state) deterministically. Done when:

1. All 3 phases ship; every command in the table exists, contract-tested against a live server.
2. `lionidas` resolves on PATH from any directory (outside the repo), talking to the local stack; `LIONIDAS_URL` redirects to a remote one.
3. PAT auth works end-to-end: browser approval flow + settings paste + `Bearer` + revocation; role gates honored (operator token can write, viewer cannot).
4. `docs/agent-playbook.md` expresses the full workflow as CLI calls.
5. Full gates green (server suite, web build, CLI contract tests, signature scan).

## In / Out of scope

**In:** `cli/` workspace package (commander-style arg parsing — exact lib pinned at build start; criterion: zero heavy deps, active TS support); client layer (fetch, auth, retries, `--json`); stack supervision (pidfile group, health, node-ABI guard); PAT server additions (api_tokens table + mint/approve/revoke routes + web settings surface for paste); all commands in the table (3 phases); playbook doc; contract tests per command.
**Out:** MCP adapter (later, wraps CLI); standalone compiled binaries; launchd/brew services; multi-server remote management (one `LIONIDAS_URL`); direct DB access from the CLI (forbidden by architecture); shell completions (phase-4 candidate).

## Verified facts (code survey 2026-09-30)

- ~120 REST routes exist covering every command domain; key bindings verified: `POST /api/templates/:id/play` (body: udid/triggeredBy/scenarioId/env/variant — variant pinning supported), `GET /api/runs/:id` (full run row incl. status), `GET /api/runs/:id/steps`, `GET /api/runs/:id/steps/:idx/triage`, `GET /api/templates/:id/yaml` + `PUT` (validating), `GET/POST /api/folders`, `POST /api/folders/move`, `GET /api/folders/:id/subtree-cases`, `POST /api/folders/:id/run`, suites CRUD + `POST /api/suites/:id/play`, queue `GET/DELETE`, forge (presets/scenarios/condition/traffic/mitm), devices (power/install/stream), env-vars (3 scopes + usage), screens + login/logout recipes + screens.yaml carry.
- Auth today: cookie `crucible_session` (HttpOnly, SameSite=Lax, Max-Age 12h), sessions table-backed; `POST /api/auth/login` (email/password, bot users excluded); operator-role gates via `requireRole`. **No bearer/token support exists yet** (server addition required).
- Workspace: pnpm packages `server`, `web`, `shared`; no CLI package. Node 24.12.0 (better-sqlite3 ABI). Stack: server `npx tsx src/main.ts` :9230; web vite :5230.
- PR #12 merged (main at `43c526b`); no open PRs — CLI work branches fresh off main.

## Architecture (carried from brainstorm, operator-approved)

```
cli/ package (bin: lionidas)
  command layer — intention commands; human tables default, --json everywhere; exit≠0 + {"error"} on failure
  client layer  — the ONLY server contact: base URL (env LIONIDAS_URL > ~/.lionidas/config.json > http://127.0.0.1:9230),
                  auth (Bearer PAT > session cookie), timeout/retry, id|name resolution helpers
  stack layer   — up/down/restart: spawn detached (server+web), pidfile group ~/.lionidas/stack.pids,
                  health poll, Node ≥24.12 guard, port-conflict detection (9230/5230 in use → say so, don't fight)
server
  ~120 existing routes (unchanged surface) + NEW auth-only additions:
    api_tokens table (user_id, name, token_hash, role, created/last_used, revoked_at)
    POST /api/auth/cli/start {code, url} · POST /api/auth/cli/approve (operator web session) · POST /api/auth/token (paste)
    GET /api/auth/tokens · DELETE /api/auth/tokens/:id (revoke)
    Bearer PAT parsing in registerUserResolution — ORDER MATTERS (review F1):
      1. cookie session (unchanged, first)
      2. NEW: Authorization: Bearer lion_<hex> → api_tokens lookup by token_hash
         index, constant-time compare, revoked_at check, throttled last_used touch;
         resolves to the CREATING user's row + role; EARLY RETURN (never falls
         through to bot paths — a PAT is a person, not a bot)
      3. existing agent/bot token paths (x-crucible-agent + Bearer crucible-…)
         UNCHANGED — the lion_ prefix disambiguates; coexistence is tested
```

- **Never** direct DB access from the CLI; the server remains the single writer (no locking/migration hazards, same reason the web app is an API client).
- Contract tests per command against a live server (spawned by the test, on a scratch port + tmp DB — the env-vars-routes test pattern scaled up).

## Command spec (the contract)

Global: `--json` on every command; file args accept `-` (stdin); `<id|name>` resolution everywhere (name → id via list lookup; ambiguity = error naming candidates); env overrides `LIONIDAS_URL`, `LIONIDAS_TOKEN`.

### Phase 1 — agent loop
- `stack up [--dev]` / `down` / `restart` / `status` / `doctor` — status prints health, ports, pids, node version; doctor = setup.sh --check + ABI guard
- `auth login [--email --password | --token T]` (default: approval flow — prints URL+code, polls), `auth status`, `auth logout`
- `context [--app A]` — apps, booted devices, case tree, env keys, active runs (one JSON doc)
- `case list [--app A] [--folder F]`; `case new <file|->`; `case get <id|name>`; `case edit <id|name> <file|->`; `case run <id|name> [--device U] [--variant V] [--env K=V…] [--wait]` (default waits, streams step lines); `case verify <id|name> [...]` — EXIT CODES (review F4): 0 = passed (all steps green); 1 = case FAILED (a step failed — triage pointer printed); 2 = INFRA (aborted/blocked: stream gate, device busy — NOT a case regression; message says fix the environment and re-run)
- `run get <id>` / `run steps <id>` (with narrate lines) / `run abort <id>`
- `env list [--scope global|app|plan] [--app A]` (secrets ALWAYS masked — the server never returns plaintext after write; a `--reveal` would need a new server route with its own review, dropped from phase 1 — F5) / `env set <K> <V> [--scope] [--app] [--secret]` / `env delete <K> [--scope] [--app]`

### Phase 2 — authoring
- `case yaml|duplicate [--name]|delete [--force]|export [--folder] [--out]|import <zip|->|versions`
- `folder list [--app A]` (tree + counts) / `folder new <path> [--app A]` (parents auto-created) / `folder move <case> <path|/>` / `folder rename <path> <name>` / `folder delete <path> [--force]` (non-empty → surfaces the server's 409 counts) / `folder run <path> [--device U]` (subtree cases)
- `screen list|register <yaml|-> [--app A]|login-flow [file|->]|logout-flow [file|->]|export [--out]|import <yaml|->`
- `suite list|new <yaml|json|->|play <id|name> [--device U] (per-lane results)|delete [--force]`

### Phase 3 — network + devices + ops
- `net presets list [--endpoint "GET /x"]|new <json|-> [--name]|edit <id|name> <json|->|delete <id|name>` (override-row guard surfaces 409)
- `net scenarios list [--folder F]|new <yaml|->|delete <id>` (consumer-name guard surfaces)
- `net condition set <preset> --device U|clear --device U|status --device U` (preset ∈ the seven)
- `net traffic tail [--n 25] [--method M] [--path P]`; `net mitm start|stop`
- `device list [--booted]|power <udid> on|off|install <udid> <path>`
- `run list [--case] [--status] [--limit]|triage <runId> <idx>|evidence <runId> [--idx] [--out DIR]`
- `queue ls`; `flake ls`

## Implementation stages (TDD; each phase ships usable)

### Stage 0 — scaffolding + client + interim auth
`cli/` package (tsconfig, bin entry, commander-style parser); client layer (URL/auth/retry/--json/errors); `auth login --email/--password` (cookie jar → ~/.lionidas/config.json 0600); `stack status` (read-only first); contract-test harness — NAMED MECHANISM (review F2): one shared `cli/test/harness.ts` calling `buildApp` (server/src/index.ts) with tmp `CRUCIBLE_DB_PATH` + `CRUCIBLE_WATCHDOG=0` + silent logging, then `app.listen({ port: 0 })` — a REAL listening ephemeral server (the CLI is an HTTP client; `inject` cannot exercise the client layer); per-command tests import it, point the client via `LIONIDAS_URL=http://127.0.0.1:<port>`, teardown closes app + deletes tmp DB. Gate: `lionidas --help`, `auth status`, `stack status` against the live stack; tests green; **linked `lionidas` resolves from `~` with its path printed — `pnpm --filter cli link --global`, documented fallback (build + `npm i -g cli/` or setup.sh alias) if the pnpm global bin isn't on PATH (F6)**.

### Stage 1 — PAT server additions + approval flow + agent loop commands
1. Server: `api_tokens` (guarded CREATE), Bearer parsing in the session hook (token → user+role; last_used touch), mint/approve/paste/revoke routes; settings UI: tokens panel (create/revoke + copy-once).
2. CLI: `auth login` approval flow (start → print URL/code → poll → store PAT); `stack up/down/restart` (supervision, pidfile group, ABI guard); `context`; `case new/get/edit/run/verify/list`; `run get/steps/abort`; `env list/set/delete`.
3. Contract tests per command (happy + guarded-failure paths); playbook skeleton (docs/agent-playbook.md).

### Stage 2 — authoring commands
`case yaml/duplicate/delete/export/import/versions`; `folder` group (list/new/move/rename/delete/run — decision 5); `screen` group (incl. login-flow/logout-flow get/put + yaml carry); `suite` group. Contract tests; playbook authoring section.

### Stage 3 — network + devices + ops
`net` groups (presets/scenarios/condition/traffic/mitm); `device` group; `run list/triage/evidence`; `queue ls`; `flake ls`. Contract tests; playbook ops section; final gate (all suites + scan).

### Branch / PR
Fresh branch `feat/lionidas-cli` off main (`43c526b`+). One PR per phase (3 PRs) or one PR with phase commits — operator preference at merge time; phase 1 is the first reviewable unit.

## Edge and failure cases

- Stack down → every non-stack command exits with a structured error pointing at `lionidas stack up` (never a raw ECONNREFUSED dump).
- Port conflict on `stack up` → report who holds :9230/:5230 (lsof) and exit; never kill unknown pids.
- Stale pidfile reconciliation (review F3): `stack status`/`down`/`restart` compare the pidfile group against ACTUAL port listeners (lsof is the truth): dead group pids → prune entries with a note; listeners on our ports NOT in the group (e.g. a manually started `pnpm dev`) → foreign — reported with pid/command, left untouched; `down` stops only pids it owns.
- Node < 24.12 → `stack up`/`doctor` refuse with the ABI explanation (the standing trap).
- PAT revoked mid-session → 401 → client surfaces "token revoked — lionidas auth login" once, no retry loop.
- `id|name` ambiguity (two cases same name in different folders) → error listing candidates with ids.
- Guarded deletes (folder non-empty, preset override rows, scenario consumers) → print the server's named-409 verbatim (the counts ARE the operator UX).
- Secrets: `env list` masks ALWAYS (server contract); PAT stored hashed server-side, plaintext shown once at creation.
- Slow runs: `case run` default wait polls `/api/runs/:id` until terminal + timeout flag `--timeout <s>` (default 600); `--no-wait` prints the run id immediately.

## Validation and acceptance

| Check | Pass condition |
|---|---|
| Contract tests | every command, phase-gated: happy path + primary failure path against a scratch server |
| PATH | `lionidas` callable from `~` (outside repo) after `pnpm --filter cli link --global` — decision 3's note |
| Auth | approval flow mints PAT from a logged-in web session; paste flow works; `Bearer lion_` honored on role-gated route (operator writes, viewer 403s); revoke → 401; **PAT and bot token coexist on one server, each resolving to its own identity (F1)** |
| Agent loop drill | from a clean shell: `stack up` → `context` → `case new` (yaml from stdin) → `case verify <name> --device <udid>` → exit 0; introduce a failing case → exit 1 + triage pointer; simulate infra abort (device busy) → exit 2 with the environment message |
| Playbook | docs/agent-playbook.md reproduces the drill using only CLI calls |
| Full gate | server suite + web build + CLI tests + signature scan, all green |

## Rollout / handoff

3 phase PRs (or one, operator's call at merge); no DB migrations beyond the guarded `api_tokens` table; web UI gains only the tokens settings panel; docs (agent-playbook.md) land with phase 1 and grow. Follow-ups (out of scope): MCP adapter wrapping the CLI, standalone binaries, shell completions.
