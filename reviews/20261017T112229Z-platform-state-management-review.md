# Review — Platform State Management Phase A plan

- Plan reviewed: `plans/20261017T112229Z-platform-state-management.md` (as written 2026-10-17, **after** the three corrections below were applied during this review pass)
- Sources: brainstorm `brainstorm/20261016T090442Z-platform-state-management.md` (full decision log), live-tree greps dated 2026-10-16 (`manual/playback.ts:87/:124/:665/:1400+`, `alloy/runner.ts:25/82/138`, `shared/src/case-yaml.ts:22/92/924`, `manual/template-env.ts:39`, DB `.tables` for `app_login`/`app_logout`/`app_screens`), crucible skill (plan self-review checklist a–r, frozen invariants).
- Verdict: **Ready for implementation** — human gate pending (operator audits plan + diffs; merge is human-only). No Critical findings. One High and two Medium findings were found **during this review** and were **fixed in the plan in the same pass**; findings below document them for audit.

## Coverage / traceability

All four operator decisions trace to plan work: Q1 (harness actuators) → S4 + edge rows 4/17; Q2 (mid-steps) → S1 grammar + objective #4; Q3 (rebuild) → S5 + edge row 15; deep-links-optional/lazy → recipe shapes (walk = default arm; deep link only inside `entry`) + registry authoring note. Objective #1–#5 each map to stages S1–S8 and to named acceptance evidence (run ids / command outputs in the PR description). Out-of-scope list matches the brainstorm's don't-overcomplicate list plus the Phase B deferral.

## Findings (prioritized)

| ID | Sev | Location | Finding & evidence | Consequence | Correction (applied?) | Verify |
|---|---|---|---|---|---|---|
| F1 | High | S5, edge row 15 | Original plan translated `ensureLogin` straight to registry convergence, but the live code resolves THREE sources — app_login row → legacy screen block → **inline selectors on old cases** (playback.ts:1400+). Hard-routing to the registry would break the oldest cases silently. | Legacy inline-selector cases fail or, worse, resolve to a wrong app-level login. | **Applied**: full resolution order preserved (app_states entry → frozen app_login row → inline); parity test per SOURCE, not aggregate. | Three parity tests (registry/row/inline) + login-suite regression green. |
| F2 | Medium | S4 | Mid-run terminate+relaunch was an unverified assumption — stream, evidence recording, overlay dims, and Forge pins across an app restart were nowhere tested. | An actuator that passes its own test but silently kills run evidence or drops Forge pins in production drills. | **Applied**: relaunch-continuity is an explicit S4 verification drill under a pinned scenario; edge row 17 added. | Drill green with stream/evidence/overlay/pins all alive across one relaunch. |
| F3 | Medium | S4 | Actuator wire contracts (`simctl privacy` flags, uninstall/reinstall cycle, the exact app-terminate verb in the alloy seam) were written from memory — the crucible lesson-l class (transcribing external APIs from docs ships dialect drift). | Wrapper code built on an unverified verb/flag fails at first live use. | **Applied**: S4 now mandates live wire-probes on a booted sim BEFORE wrapper code, outputs committed with the task. | Probe notes exist in the task; wrappers match pinned shapes. |
| F4 | Low | S4 wording | "relaunch via `alloy_apps` close/open" assumed a `close` action exists (only `open` with `launchArgs` was verified). | Possible hunt for a nonexistent verb mid-implementation. | **Applied**: wording now "the app-terminate verb in the alloy app-control seam — exact verb verified, not assumed", folded into F3's probe. | Covered by F3 probes. |
| F5 | Low | Objective #2 | Acceptance reads `path: "probe-hit"` from `run_steps` audit JSON directly; UI text rendering of provenance is Phase B. | None if disclosed — an auditor might expect UI text. | Disclosed here (no plan change needed; plan already scopes provenance UI to Phase B). | Drill cites the SQL/audit evidence. |
| F6 | Medium | S8 drill (b) | `uninstallReinstall` needs a resolvable artifact at drill time; the original plan never stated the precondition. | Drill (b) blocks mid-acceptance on a missing artifact. | **Applied**: S4 drill-precondition line added (resolve package or build first). | Drill (b) precondition resolved before the drill runs. |

## Questions for the human

None blocking. One disclosed design choice to note at the gate: the states editing surface is placed as a **section on the existing screens page** (kinship with the screens registry; the ensureLogin error text already directs users there) rather than a new page — if you prefer a standalone page, say so before S6; it does not affect S1–S5.

## Properties inspected vs. still open

Inspected on paper: decision traceability, schema placement law, busy-guard semantics (incl. self-exclusion), migration completeness (per-source parity), grammar round-trip coverage, acceptance measurability. Requires execution: all live drills (S8), visual/a11y harness results (S6), login-suite regression (S5), relaunch continuity (F2). This review cannot certify implementation correctness — only that the plan is executable without invented requirements.

## Necessary edits to the plan

Applied during this review (F1, F2, F3/F4, F6 — see table). Plan version reviewed = post-edit.
