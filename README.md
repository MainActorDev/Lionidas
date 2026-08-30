# Crucible

> The E2E testing control dashboard. *Your app. Proven.*

Crucible gives QA and engineers one shared control surface over end-to-end UI
testing: a live device wall, test-run orchestration, acceptance-criteria status,
evidence management, and baseline governance — executing through
[Alloy](https://github.com/MainActorDev/Alloy) (in-process, engine-neutral).

**Status: M0 (scaffold).** Full architecture and phase gates: [PLAN.md](./PLAN.md) ·
per-phase implementation contracts: [plans/](./plans/) · UI direction:
[plans/UI-direction.md](./plans/UI-direction.md).

## Quick start

```bash
pnpm install
pnpm dev            # server :9230 + web :5173
curl localhost:9230/api/health
```

## Design invariants

- Web never imports server code; the orchestrator is Alloy's only client.
- Runs are immutable; corrections are new runs.
- Status is computed, never stored; manual runs never roll up.
- Engine-neutral by construction (CI signature scan, same as Alloy).
- Production-grade bar: structured logging, graceful shutdown, fail-fast config,
  validated inputs, no placeholder code shipped.

## License

MIT — see [LICENSE](./LICENSE).
