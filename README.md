<div align="center">
  <img src="web/public/icons/lionidas-avatar-dark-512.png" width="160" alt="Lionidas" />
</div>

<h1 align="center">Lionidas</h1>

<p align="center"><strong>The E2E testing control dashboard. Your app, proven.</strong></p>

<p align="center">
  <a href="https://github.com/MainActorDev/Lionidas/actions/workflows/check.yml"><img src="https://img.shields.io/badge/CI-passing-brightgreen" alt="CI" /></a>
  <img src="https://img.shields.io/badge/tests-1004%20passing-brightgreen" alt="tests" />
  <img src="https://img.shields.io/badge/node-24.12-blue" alt="node" />
  <img src="https://img.shields.io/badge/engine-Alloy%20%28in--process%29-blueviolet" alt="engine" />
  <img src="https://img.shields.io/badge/license-MIT-green" alt="license" />
</p>

<p align="center">
  <a href="#setup">Setup</a> ·
  <a href="#what-lionidas-does">What it does</a> ·
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

## The four nouns

| Noun | What it is | Where |
|---|---|---|
| **Template** | A test case in YAML — variants, steps, expects | `templates` page |
| **Screen** | A registered screen: entry, refresh, states | `screens` page |
| **Run** | One immutable execution with evidence | `runs` page |
| **Forge** | The network-condition layer (presets, scenarios) | `forge` page |

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

```bash
bash scripts/setup.sh
```

Installs what's missing and reports honestly at each step: Node 24.12
(pinned — 24.20 crashes worker pools on arm64), pnpm, dependencies, the
[Alloy](https://github.com/MainActorDev/Alloy) engine as a sibling clone
(`../alloy`), mitmproxy (the forge proxy), and checks Xcode/simctl. Safe to
re-run; `pnpm doctor` is the check-only mode.

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
- Production-grade bar: structured logging, graceful shutdown, fail-fast
  config, validated inputs, no placeholder code shipped.

## Docs map

- [Feature docs](docs/features/README.md) — how each feature works: sweep
  (selector resolution), CI mode, inspect mode, location, tap overlay
- [ADR-0001](docs/adr/ADR-0001-ios-first-platform-seams.md) — iOS-first
  platform seams (why the orchestrator is engine-blind)
- [PLAN.md](PLAN.md) — architecture and phase gates · [plans/](plans/) —
  per-phase implementation contracts
- [DEFERRED.md](DEFERRED.md) — what was consciously not built (yet)

## License

MIT.
