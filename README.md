<div align="center">
  <img src="web/public/icons/lionidas-mascot-512.png" width="160" alt="Lionidas" />
</div>

<h1 align="center">Lionidas</h1>

<p align="center"><strong>The E2E testing control dashboard. Your app, proven.</strong></p>

<p align="center">
  <a href="https://github.com/MainActorDev/Lionidas/actions/workflows/check.yml"><img src="https://img.shields.io/badge/CI-passing-brightgreen" alt="CI" /></a>
  <img src="https://img.shields.io/badge/tests-1353%20passing-brightgreen" alt="tests" />
  <img src="https://img.shields.io/badge/node-24.12-blue" alt="node" />
  <img src="https://img.shields.io/badge/engine-Alloy%20%28in--process%29-blueviolet" alt="engine" />
  <img src="https://img.shields.io/badge/license-MIT-green" alt="license" />
</p>

<p align="center">
  <a href="#setup">Setup</a> ·
  <a href="#what-lionidas-does">What it does</a> ·
  <a href="#projects--builds">Projects & builds</a> ·
  <a href="#the-four-nouns">Concepts</a> ·
  <a href="#the-yaml-grammar">YAML grammar</a> ·
  <a href="#env-seeded-runs">Env</a> ·
  <a href="#ci-mode">CI</a> ·
  <a href="#design-invariants">Invariants</a> ·
  <a href="#docs-map">Docs</a>
</p>

---

Lionidas gives QA and engineers one shared control surface over end-to-end UI
testing of iOS apps: a live device wall, test-run orchestration, a screen
registry with reusable login procedures, environment-seeded runs, network
scenario swapping, verdicts with evidence, and baseline governance — executing
through [Alloy](https://github.com/MainActorDev/Alloy) (in-process,
engine-neutral).

You write test cases as YAML. Lionidas plays them on real simulators, verifies
screen states instead of pixel matches, and keeps the proof — screenshots,
AX trees, network traffic — attached to every run.

## What Lionidas does

- **Runs your flows on real devices.** Templates (test cases) play step by step
  on booted simulators through the Alloy engine: taps by accessibility
  identifier or label, text fills, scrolls, expects with settle detection.
- **Knows your screens.** Every screen is registered once — its entry path
  (multi-hop taps, deep links, tab selects), refresh gesture, and named states.
  Cases reference screens by id; navigation and verification resolve against
  the registry, not magic coordinates.
- **Owns login as an app-level procedure.** One login definition per app —
  entry, form controls, submit, and a session state to verify. Any case says
  `ensure login` and gets a logged-in device; no screen "owns" the form, and
  deleting a screen can never destroy it.
- **Seeds runs from managed env.** Credentials and config live in scoped env
  vars (global → app → plan → request → variant); cases reference
  `${env.DRILL_PHONE}` — no secrets in YAML, ever.
- **Swaps network reality.** The forge (mitmproxy) presets and scenarios can
  stall, throttle, or fail specific endpoints mid-run — and refresh gestures
  verify the app actually re-fetched.
- **Keeps the evidence.** Every run carries screenshots, AX snapshots,
  traffic, and a step ledger — with black-display and confirm guards so a
  "pass" always means a live screen proved it.
- **Sidelining, not hiding.** Flaky flows are detected and sidelined out of
  the pass-rate math instead of lying to the matrix.
- **Builds what it tests.** Register an app repo, and Lionidas clones it,
  resolves build inputs (repo `lionidas.yml` manifest > registry pins >
  discovery — fail-fast on ambiguity), builds simulator IPAs via
  [xcbuddy](https://github.com/MainActorDev/xcbuddy) (raw xcodebuild
  fallback), smoke-tests every artifact (install → launch → 10s-alive on a
  booted simulator — a crash fails the build and drops the artifact), stamps
  `CFBundleVersion` with the build number, and plays suites against a chosen
  build — two verdicts per row: *the artifact works* and *the code behaves*.

## Projects & builds

The `projects` page registers app repositories (clone/pull into a managed
workspace; auth rides the `CRUCIBLE_GITHUB_TOKEN` env field — tokens are
never typed into the UI or stored in the DB). The `builds` page is a
Jenkins-style table: one row per build with status, scheme/configuration
provenance, console drawer, and — for passing builds — a ▶ test action that
plays a suite against that exact artifact, aggregating a suite verdict chip
on the row.

Build config lives **in your repo** as `lionidas.yml` (strict: scheme,
configuration, a `prepare:` run list) — Lionidas never owns your build
definition. Artifact retention keeps the last N per project (default 10)
with evidence immunity: anything referenced by a run, plus the newest
passing build, is never reclaimed.

## The four nouns

| Noun | What it is | Where |
|---|---|---|
| **Template** | A test case in YAML — variants, steps, expects | `templates` page |
| **Screen** | A registered screen: entry, refresh, states | `screens` page |
| **Run** | One immutable execution with evidence | `runs` page |
| **Forge** | The network-condition layer (presets, scenarios) | `forge` page |
| **Project** | A registered app repo: clone, manifest, builds | `projects` page |
| **Build** | A compiled artifact: smoke-gated, stampable, testable | `builds` page |

Login procedures are app-level (edited per app), env vars are scoped, and
plans compose templates into ordered lanes.

## The YAML grammar

A template says what to do and what must be true — in order:

```yaml
name: account legal opens
variants: []
steps:
  - ensure login:
      phone: ${env.DRILL_PHONE}
      password: ${env.DRILL_PASSWORD}
  - tap: ic_tabbar_account_inactive
  - tap: account_legal_privacy_row
  - expect:
      screen: account-legal
      state: legal_doc_privacy_screen
```

- **`ensure login` / `ensure logout`** — play the app's login procedure (or its
  inverse) before continuing; the screenless form resolves every selector from
  the app-level definition.
- **steps** — `tap` (identifier/label/point), `fill`, `scroll`, `swap`
  (network scenario), `refresh` (the screen's declared gesture), and more.
- **`expect`** — a registered screen + named state, with settle-aware polling;
  the run is honest about what never appeared.
- Screens are registered as YAML too — the editor is a live document with a
  form beside it; the document owns the truth at save.

Full grammar: `shared/src/case-yaml.ts` (the parser is the contract, and its
tests are the spec).

## Env-seeded runs

No hardcoded credentials — anywhere. Env vars resolve in a strict chain:

```
global  <  app:<bundle>  <  plan:<id>  <  request body  <  variant
```

Manage them on the **env** page: scope cards, missing-key gaps strip, masked
secrets (a blank edit keeps the stored value), and usage scans that show which
cases reference which keys.

## CI mode

The CLI runs template suites against a live server and speaks exit codes:

| Code | Meaning |
|---|---|
| 0 | every run passed |
| 1 | app failure — an expect didn't match, a step failed honestly |
| 2 | infrastructure — device busy, stream gate, server unreachable |

`--junit out.xml` writes one `<testcase>` per run for CI reporters.
Details: [docs/features/ci.md](docs/features/ci.md).

## Setup

First run? The **setup wizard** handles it: start the server, open the app,
and you're routed to `/setup` — create your admin account with the claim
token printed on the server console (proof you control the machine; the
window closes forever once claimed). Existing installs upgrade without
seeing the wizard. Headless installs: set `CRUCIBLE_PIN` (auto-completes
setup) or `CRUCIBLE_SETUP_MODE=off` (legacy behavior). Locked out?
`pnpm --filter server cli -- admin reset-password <email>`.

```bash
bash scripts/setup.sh
```

Installs what's missing and reports honestly at each step: Node 24.12
(pinned — 24.20 crashes worker pools on arm64), pnpm, dependencies, the
[Alloy](https://github.com/MainActorDev/Alloy) engine as a sibling clone
(`../alloy`), mitmproxy (the forge proxy), and checks Xcode/simctl. Safe to
re-run; `pnpm doctor` is the check-only mode.

### Operator environment

Secrets are env fields, never app-stored: `CRUCIBLE_GITHUB_TOKEN` (repo
clone/pull auth), `JIRA_TOKEN` + `CRUCIBLE_JIRA_CLIENT_ID/SECRET` (agent
and SSO). The **settings** page mirrors their presence (never values) and
runs a readiness checklist — tokens, storage dirs, Xcode, xcbuddy, smoke
probe — with the exact fix per row.

| Env | Purpose |
|---|---|
| `CRUCIBLE_DB_PATH` / `CRUCIBLE_REPOS_DIR` / `CRUCIBLE_ARTIFACTS_DIR` | storage locations |
| `CRUCIBLE_GITHUB_TOKEN` | repo clone/pull auth (env, never UI) |
| `CRUCIBLE_PIN` | headless admin bootstrap password |
| `CRUCIBLE_SETUP_MODE=off` | disable the setup wizard (legacy) |
| `CRUCIBLE_SMOKE=0` | skip the build smoke gate (hosts without simulators) |
| `CRUCIBLE_API_TARGET` | point the dev web proxy at another API instance |

## Quick start

```bash
pnpm install
pnpm dev            # server :9230 + web :5230
curl localhost:9230/api/health
```

## Checks

```bash
pnpm check          # typecheck + lint + signature scan + tests
```

Machine-bound test files (live mitmdump, the sibling Alloy repo, simctl)
skip with a named reason when their capability is absent — an honest skip,
never a fake pass.

## Design invariants

- Web never imports server code; the orchestrator is Alloy's only client.
- Runs are immutable; corrections are new runs.
- Status is computed, never stored; manual runs never roll up.
- Engine-neutral by construction (CI signature scan, same as Alloy).
- Credentials live in env scopes, never in templates or code.
- Login is an app-level procedure; screens reference it, none own it.
- Build config lives in the repo (`lionidas.yml`), never in Lionidas.
- Secrets are env fields; the DB never stores token values.
- Production-grade bar: structured logging, graceful shutdown, fail-fast
  config, validated inputs, no placeholder code shipped.

## Docs map

- [Feature docs](docs/features/README.md) — how each feature works: sweep
  (selector resolution), CI mode, inspect mode, location, tap overlay
- [ADR-0001](docs/adr/ADR-0001-ios-first-platform-seams.md) — iOS-first
  platform seams (why the orchestrator is engine-blind)
- [Testing the setup wizard](docs/testing-setup-wizard.md) — isolated
  test-instance guide (port 9231, throwaway DB, upgrade path, recovery)
- [The agent layer](docs/agent.md) — the embedded AI test-case authoring
  agent (reads everything, drafts through the real validator, never touches
  devices); MCP + conversation API, drill log in
  [docs/agent-drills.md](docs/agent-drills.md)
- [PLAN.md](PLAN.md) — architecture and phase gates · [plans/](plans/) —
  per-phase implementation contracts
- [DEFERRED.md](DEFERRED.md) — what was consciously not built (yet)

## License

MIT.
