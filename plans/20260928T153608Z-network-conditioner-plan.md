# Network conditioner — manual + run-scoped (plan)

- Source brainstorm: `brainstorm/20260928T153608Z-network-conditioner.md` (all questions answered 2026-09-28)
- Status: Ready (rev 2 — review findings applied; F1 resolved by operator: VARIANT-ONLY pins)

## Objective and completion conditions

Lionidas can condition a simulator's network via Baguette, both **manually** (network page control) and **run-scoped** (a case/variant pins a preset; applied before app launch, cleared when the run ends). Done when:

1. The network page control strip offers: device picker (booted sims) → condition preset (`wifi/dsl/lte/3g/edge/very-bad-network/100-loss`) or clear, with live status readback. Presets ONLY (operator: "Presets only. But make it vary" — the seven-profile set is the variety).
2. Case YAML/variants can pin `network: <preset>`; at play, the condition is set BEFORE the app launches (Baguette dyld constraint), and cleared in the run's finally path — a failed/aborted run cannot leave a sim degraded.
3. Runs stamp the applied condition for provenance (visible in run detail/note context).
4. Baguette-absent environments degrade honestly: manual control returns a clear error; run-scoped pins FAIL the run pre-flight with an actionable message (a silent pass would lie about what was tested).
5. Suite green (new tests: preset vocabulary round-trip, shim parsing, run integration ordering: set-before-open, clear-after-finally); live drill on 30B28173.

## Verified facts (2026-09-28)

- Baguette binary: `/Volumes/berkakyo/Users/berkamain/Developer/w0rk/lionparcel/ai/Baguette/Baguette` (25MB build). NOT on PATH — resolution order: `BAGUETTE_PATH` env → `~/.alloy/baguette.json {baguettePath}` style config (reuse the alloy config pattern) → sibling-repo default `<workspace>/Baguette/Baguette`.
- CLI contract, verified LIVE on 30B28173: `network set --profile 3g` → "Network conditioned… Relaunch the app to pick it up."; `network status` → "iPhone 14 Plus network: 200 ms latency, 780 kbps" / "no network conditioning applied."; `network clear` → "Network conditioning cleared". Exit 0 on all.
- Presets (docs/features/network.md + NetworkProfileTests): wifi 40000kbps/2ms, dsl 2000/10, lte 50000/130, 3g 780/200, edge 240/800, very-bad-network 1000/1000/10%, 100-loss —/—/100%.
- Constraints (same doc): only URLSession-shaped traffic; only apps launched AFTER set are conditioned; condition changes on a RUNNING app apply in ~100ms (no relaunch needed for updates).
- App launch in playback: `server/src/manual/playback.ts:582` (`alloy_apps open` with `-uitest-live-refresh`), preceded by the TCC/env setup around :559-578 — the condition set must precede this open call.
- Variant storage: `templates.variants_json` entries `{id, networkScenario?, scenarios?, env?}`; case YAML emits `networkScenario:`/`scenarios:` today (shared/src/case-yaml.ts:598-601). The new `network:` key joins this shape; playback reads variants at manual.ts:445-447.

## In / out of scope

**In**: Baguette CLI shim (server); preset vocabulary in shared; manual control UI (network page strip); variant-only `network:` pin (variants_json — no schema change); playback integration (pre-launch set, finally clear, stamping, batch named-skip); honest-absence errors; tests + live drill.
**Out**: custom latency/bandwidth/loss inputs; alloy/device-daemon verbs (deferred until a second consumer); conditioning WKWebView/raw-socket traffic (Baguette limit); Forge preset changes; multi-device batch conditioning beyond what runBatch's per-lane udid already implies (each lane conditions its own udid).

## Architecture

### Shared preset vocabulary (`shared/src/network-profiles.ts` — new)
`NETWORK_PROFILES: Array<{ id, label, bandwidthKbps, latencyMs, lossPct }>` (the seven, verbatim from Baguette's doc) + `isNetworkProfile(id)`. Single source for UI picker, yaml validator, autocomplete, and the run note.

### Baguette shim (`server/src/forge/baguette-network.ts` — new)
- `resolveBaguettePath(): string | null` — resolution order (review F7): `BAGUETTE_PATH` env → `~/.alloy/crucible.json` `baguettePath` key (the EXISTING alloy-path config file, one tool-path home) → sibling-repo default `<workspace>/Baguette/Baguette`; null = absent.
- `baguetteNetwork(udid, op: {kind:'set', profile} | {kind:'clear'} | {kind:'status'})` — execFile with timeout (5s). EXIT CODES are the contract for set/clear; `status` stdout parsing is BEST-EFFORT DISPLAY ONLY (review F4 — the output is human prose incl. the device name; on parse mismatch return `{conditioned:'unknown', raw}` with the raw line, never an error). Never throws for absent binary (returns `{ok:false, reason:'baguette-absent'}`).
- Unit-tested with an injected fake runner (argv assertions): `network set --udid U --profile 3g`, `network clear --udid U`, `network status --udid U`; malformed status line → `{conditioned:'unknown', raw}`.

### Server routes (`server/src/forge/routes.ts`)
- `GET /api/forge/network-condition?udid=` → status (absent binary → 200 `{available:false}` so the UI can gray out honestly)
- `POST /api/forge/network-condition` `{udid, profile|null}` → set/clear; 409 with guidance when absent; 400 unknown profile (checked against shared vocab).

### Case grammar (`shared/src/case-yaml.ts`) — VARIANT-ONLY (review F1, operator 2026-09-28)
- `network: <preset>` lives ONLY inside variant blocks (alongside `networkScenario`/`scenarios`/`env`) — the carrier is `templates.variants_json`, which already round-trips; NO new column, NO case-level key this round. Validator rejects unknown ids. Emit/parse round-trip tests. Autocomplete: variant-block keys gain `network` with the seven preset ids as values (case editor vocabulary).

### Playback integration (`server/src/manual/playback.ts`)
- Resolve the pin: `opts.variant?.network ?? null` (variant-only per F1; variants_json read already exists at :629-639).
- WHEN pinned and resolved: AFTER env/TCC setup, BEFORE the `alloy_apps open` (:582): `await baguetteNetwork(udid, {kind:'set', profile})`; failure → single play: `PlaybackError('NETWORK_CONDITION_FAILED', …)` honest stop; BATCH lane (runBatch/play-all/plans/suites): named SKIP (`network conditioner unavailable: <detail>`), batch continues (review F5).
- UNPINNED runs touch NOTHING — an existing manual condition (set from the UI) must survive a passing run (review F2).
- The run's done/finally path: `baguetteNetwork(udid, {kind:'clear'})` — best-effort (catch), logged into the run note; fires on abort too (the location-hygiene precedent at :452/:1184/:1773 — condition set/clear mirrors `locationSet`).
- Concurrency invariant (review F3, precise): same-device runs are serialized (QUEUE_ACTIVE); parallel batch lanes run on DIFFERENT udids — each lane's finally clears only ITS udid. No cross-clear is possible; test pins it.
- Stamp: `runs.note` gains ` · net:<preset>`; run detail context renders it.

### Web (`web/src/pages/ForgePage.vue`)
- Control strip segment: `condition` — device select (`GET /api/devices`, booted-only filter; review F6; default the wall's pinned/first booted), preset select (seven + `clear`), status line under the strip refreshed after ops + on load (`available:false` → disabled with tooltip "baguette not found — set BAGUETTE_PATH").

## Stages

1. **Shared vocab + shim (TDD)**: network-profiles tests (seven pinned), baguette-network argv/parse tests with fake runner. Deliverable: green units.
2. **Routes**: condition status/set/clear + absent-binary semantics. Tests via app.inject.
3. **Grammar (variant-only)**: `network:` parse/emit/validate inside variant blocks + round-trip tests; case-editor variant-block autocomplete gains the key + seven values.
4. **Playback**: pin resolution (`opts.variant?.network`), pre-launch set ordering test (fake shim asserting set-before-open via call order), finally clear (incl. abort path), unpinned-run-touches-nothing test (F2), per-udid isolation under parallel lanes (F3), batch named-skip on absent shim (F5), stamping. Tests with injected fake shim.
5. **UI**: control strip segment + drill (live on 30B28173: set 3g → status shows it → clear; play a `network: edge` variant → condition applies pre-launch, clears after; abort mid-run → cleared; manual condition survives an unpinned run).
6. **Full gate**: suite + build; PR on a fresh branch.

## Edge and failure cases

- Baguette absent: manual → 409 + tooltip; run-scoped → run fails pre-flight with the fix (install/build Baguette or set BAGUETTE_PATH). Never silently unconditioned.
- App already running when a manual set happens: UI copy carries Baguette's own caveat ("relaunch the app to pick it up").
- Two runs racing the same sim: condition set/clear are per-udid last-write-wins — playback's existing single-active-run-per-sim queue already serializes this; note in plan, no new lock.
- Abort mid-run: finally still clears (test plants an abort and asserts clear fired).
- Unknown profile in a hand-edited variant json: validator error at save; at play (legacy rows) → single play fails honestly naming the id; batch lane skips with the named reason.
- `network: wifi` pin on a variant: legal but a near-no-op condition — allowed (explicit intent).

## Rollout

Single feature branch → PR; no schema changes (variant pin rides variants_json; case-level pin rides the stored yaml/steps — no migration). Rollback = revert.
