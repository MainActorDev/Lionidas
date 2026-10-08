# Review — build-inputs plan

- Plan: plans/20261007T164500Z-build-inputs-plan.md
- Verdict: **Ready** after folding these findings

## Findings

- **[R1|High] YAML dependency unchecked.** Plan says "reuse yaml dep —
  verify". Resolution: server already ships `yaml` (zod-style validation not
  needed). Verified during implementation step T2 first action; if absent,
  vendor the 30-line parser per plan (no new dep).
- **[R2|High] Manifest precedence vs repo-lane conflict.** When
  `build-sim.sh` exists (transport=repo-lane), the LANE owns steps; manifest
  inputs are informational only (logged). Plan T4.7 states this — keep it;
  also surface in /build-inputs response so the UI can say "lane overrides".
- **[R3|Med] SCHEME_AMBIGUOUS ergonomics.** Failing the build is correct,
  but the picker modal (T6) must render candidates as clickable rows, and
  the error payload should carry the candidate list (not just a string) so
  the UI doesn't parse error text.
- **[R4|Med] builds.resolution column format.** `scheme=manifest;
  config=registry` is log-ish; make it strict JSON
  (`{"scheme":"manifest","config":"registry"}`) for queryability.
- **[R5|Low] repo_shape column placement.** Probe at clone time only —
  existing projects (already cloned) have NULL until a pull/clone reruns.
  Backfill lazily: probe also when starting a build if column is NULL.
- **[R6|Low] Preflight caching.** -showBuildSettings per build adds ~10s;
  acceptable, but skip preflight when provenance=manifest AND the previous
  build with the same inputs passed preflight (cache key: scheme+config).
  Defer unless drill shows pain — note in code comment.
- **[R7|Med] Tests must cover the ESM trap.** The require()-in-ESM bug bit
  us because vitest shims what tsx doesn't. New modules (manifest.ts) must
  avoid dynamic require entirely; add one test that imports manifest.ts the
  way main.ts does (via the server's actual loader path — i.e. run the
  module under `node --import tsx` in a smoke test) — or at minimum keep all
  imports static and lint-visible.

## Verdict

All findings foldable during implementation; no plan-structure changes.
Proceed T1→T7 in order, verifying per the plan's verification section.
