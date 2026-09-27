# Lionidas

> The E2E testing control dashboard. *Your app. Proven.*

Lionidas gives QA and engineers one shared control surface over end-to-end UI
testing: a live device wall, test-run orchestration, acceptance-criteria status,
evidence management, and baseline governance — executing through
[Alloy](https://github.com/MainActorDev/Alloy) (in-process, engine-neutral).

**Status: M0 (scaffold).** Full architecture and phase gates: [PLAN.md](./PLAN.md) ·
per-phase implementation contracts: [plans/](./plans/) · UI direction:
[plans/UI-direction.md](./plans/UI-direction.md).

## Setup (one command)

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
pnpm check          # typecheck + lint + scan + tests
```

Machine-bound test files (live mitmdump, the sibling Alloy repo, simctl)
skip with a named reason when their capability is absent — an honest skip,
never a fake pass. Provision everything via setup and they run for real.

## Design invariants

- Web never imports server code; the orchestrator is Alloy's only client.
- Runs are immutable; corrections are new runs.
- Status is computed, never stored; manual runs never roll up.
- Engine-neutral by construction (CI signature scan, same as Alloy).
- Production-grade bar: structured logging, graceful shutdown, fail-fast config,
  validated inputs, no placeholder code shipped.

## License

MIT — see [LICENSE](./LICENSE).
