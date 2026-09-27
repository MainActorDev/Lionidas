# ADR-0001: iOS-first, platform-seams-not-platforms

Status: accepted (2026-09-05)
Deciders: user + agent, after the platform-ambition review
Context: Lionidas's stated goal is a super-tool for E2E UI testing —
iOS/Android, probably web. Current and near-term focus remains iOS only.
This ADR records the preparation doctrine so the future is an addition,
not a rewrite.

## Decision

Ship iOS only. Prepare by keeping every platform-specific behavior behind
a seam that already exists or is created at the moment the code is next
touched — never by pre-building abstractions with a single implementation.

Rule of thumb: **no new iOS-ism may land without a named seam.**

## The audit (what counts as an iOS-ism, and its seam)

| iOS-ism in code today | Seam (create when next touched) |
|---|---|
| `kind = 'simulator'` in wall/stream route queries | `platformFor(device)` helper — today returns iOS-only; Android queries become one-line changes |
| Power ops = simctl passthrough (`routes/devices.ts`) | Already the adapter (alloy passthrough). Rule: no simctl calls outside this file |
| `StepSelector {label, identifier}` resolution | `resolveSelector(nodes, sel, { platform })` — current behavior becomes the `ios` branch. resource-id (Android) / CSS-role (web) matchers arrive with their platforms |
| Recording = XCTest manual session | Manual-session module is the seam; no engine calls outside it |
| `app: <bundle-id>` | Plain string today; bundle-id ↔ URL duality is free when web arrives |
| Device wall stream (MJPEG/simulator-server) | Stream-relay is transport; the *source resolution* stays in the device route |
| `simctl privacy` grants | Already confined to drills, not product code — stays that way until a real `permissions:` feature is designed |

## What we deliberately do NOT do now

- No adapter interfaces with one implementation (speculative generality)
- No Android emulator/web spikes, no device-farm work
- No schema changes preempting Android — `devices.platform` / `devices.kind`
  already carry what's needed
- No selector-strategy dispatch until selector code is next modified for
  an iOS reason

## What "prepare" does mean (active work, iOS value now)

1. Phase-0 hygiene: WAL + DB backup, quarantine flaky tests, dedupe
   `ingestEvidence`, split `playback.ts` (962 lines) — all of these are
   also prerequisites for parallel suites and other platforms
2. CI mode: headless runner, exit codes, JUnit XML — inherently
   platform-neutral interface (`run suite → verdict → report`)
3. Case authoring stays YAML-with-guards (`setup:`/`when:`/`alerts:`) —
   the case format is already platform-neutral; every case written this
   way is an Android case-in-waiting

## Platform ambition map (context for future ADRs)

The long-game architecture, when demanded:

```
Lionidas core (runs, cases, evidence, verdicts, queue)   ← platform-blind
        │
   PlatformAdapter { power, stream, grants, selectorStrategy, capabilities }
        │
   iOS adapter      Android adapter     Web adapter     (added, not rewritten)
        │
   the single device engine (our fork — see ADR-0002 when written)
```

Recent work verified as landing entirely in the platform-blind core:
alert policy, per-expect evidence, latest-only retention, dialog
interception, stream pause/resume honesty.

## Consequences

- Android/web onboarding cost stays ~one adapter + selector branch, not a port
- Reviewers (human and agent) have a table to check new iOS-isms against
- The temptation to build the whole adapter layer early is documented away
- This ADR's table is the checklist; update it when a new iOS-ism appears
