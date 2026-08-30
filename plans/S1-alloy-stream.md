# PLAN — S1: alloy_stream (true WS device streaming)

**Status: READY — awaiting approval. This plan supersedes the "fork PR blocker" mislabel: the fork is ours; the stream already exists in engine B's simulator-server. We are exposing it, not building it.**

Repos: engine-B fork (ours — the sibling checkout where every prior gap shipped) + `ai/alloy` (facade) + `ai/crucible` (consumer) · Duration: ~½ day

## 0. What exists today (grounded, no guessing)

- Engine B's simulator-server (fork package `tool-server`, blueprint `simulator-server`) **already streams video** from every booted iOS simulator: on spawn it prints `stream_ready <http-url>`; the blueprint captures it as `streamUrl` and returns it on the service API (`packages/tool-server/src/blueprints/simulator-server.ts` — `resolveWhenReady`, `spawnSimulatorServerProcess` destructure).
- Any engine-B tool that needs the service already does: `const ref = simulatorServerRef(device); const api = await registry.resolveService(ref.urn, ref.options); api.streamUrl` — the exact pattern `tools/screenshot/index.ts` uses for capture.
- Crucible's Watch currently polls `alloy_screenshot` every 2.5s (screenshot-pulse) — the workaround being replaced.
- What serves AT `streamUrl` is the simulator-server's **HTTP/WS endpoint** (MJPEG-style stream per the binary's `darwin/` bundle). Consumers open it directly; the tool-server does NOT proxy frames.

## 1. Scope & non-goals

**Ship:** `alloy_stream {udid}` → `{streamUrl, status}` in Alloy (engine B passthrough, degraded-safe), plus Crucible Watch switching to the live stream with pulse fallback.

**Non-goals:** proxying/re-encoding frames through Crucible (bandwidth + process bloat for zero value — the browser consumes the stream directly); recording from the stream (video evidence already comes from `alloy_video`'s moov-validated capture); Android/remote-MoQ streams (local iOS sims only — remote uses a different transport and stays on pulse).

## 2. Implementation

### 2.1 Engine-B fork — one minimal tool

No existing engine tool returns `streamUrl` (screenshot resolves the service but captures a PNG; `describe` output has no stream field). The fork gets ONE addition — a `simulator-stream` tool that is exactly the 3-line resolve + return:

```ts
// tools/simulator-stream/index.ts (new, mirrors screenshot's resolve pattern)
const ref = simulatorServerRef(device);
const api = (await registry.resolveService(ref.urn, ref.options)) as SimulatorServerApi;
return { streamUrl: api.streamUrl, platform: device.platform };
```

Registered in the fork's `utils/setup-registry.ts`. Schema: `{ udid }`. Capability: iOS simulator only (mirror the screenshot tool's tvOS guard). ~30 lines total, PR to our own fork — not upstream-blocked.

### 2.2 Alloy facade

- routing row `alloy_stream` (engine B, per-call lease — read-only, watching ≠ holding)
- registrations: `callBTool(client, 'simulator-stream', { udid })`, pass through `{streamUrl, platform}`
- degraded-safe: engine error → structured AlloyError; Crucible falls back to pulse

### 2.3 Crucible — Watch upgrade

- Wall tile Watch: call `POST /api/devices/:udid/stream` (new route → alloy_stream) → get `streamUrl` → render `<img :src="streamUrl">` — **confirmed MJPEG** (`multipart/x-mixed-replace;boundary=NextFrame`, path `/stream.mjpeg`, from the binary's strings) which browsers render natively in `<img>`; single render path, no detection needed
- **Fallback ladder**: stream fetch fails OR stalls (no frame in 10s) → revert to screenshot-pulse automatically, badge "pulse" so the operator knows
- Keep lease semantics: stream watch takes NO lease (unchanged)
- **Stream lifecycle (self-review F3)**: the URL is only valid while the simulator-server process lives — `<img>` onerror (server died after URL handout) is terminal for the watch session → immediate pulse fallback; re-Watch re-resolves (registry caches per-URN, repeat resolve is cheap)
- DrivePage: same upgrade — live background frame under the tap canvas

## 3. Tests (named, all required)

| File | Asserts |
|---|---|
| `alloy/test/contract.test.ts` | +`alloy_stream` fixture: dispatch → adapter calls `simulator-stream` with udid; error → structured AlloyError |
| `crucible/server/test/stream.route.test.ts` | route → alloy_stream call shape; degraded when tool missing (503 + reason, not crash) |
| live gate (below) | real URL on booted sim; frame actually arrives |

## 4. GATE (live, on this Mac)

```
G1 alloy_stream on booted iPhone 16 Pro → {streamUrl: http://127.0.0.1:PORT/..., platform: 'ios'}
G2 curl streamUrl for 3s → ≥1 frame chunk received (non-zero bytes)
G3 Crucible wall Watch → <img> shows LIVE screen (manual browser check)
G4a simulator-server dead BEFORE resolve → alloy_stream returns typed engine error
G4b server dies AFTER URL handout → <img> onerror → automatic pulse fallback
G5 full Alloy suite still green (routing-table held-set unchanged: per-call)
```

## 5. Risks

| Risk | Mitigation |
|---|---|
| ~~streamUrl format unknown~~ **RESOLVED by self-review** | Binary strings confirm: `multipart/x-mixed-replace;boundary=NextFrame` at `/stream.mjpeg` — plain MJPEG over HTTP. `<img :src>` renders it natively in all major browsers. The `<video>`/MSE path is DEAD — deleted from 2.4; one render path, confirmed |
| Long-lived stream connections exhaust server | Watch polls alloy_stream ONCE per watch session, then holds the URL; browser owns the connection lifecycle |
| Stream keeps simulator-server alive after watch closes | No change: service lifecycle is the engine's registry refcount, same as screenshots today |


## 6. Self-review findings (2026-08-30, applied)

| # | Sev | Finding | Resolution |
|---|---|---|---|
| F1 | 🔴 | §2.1/§2.2 contradicted each other ("no fork change" vs "fork needs a tool") mid-document — §2.2 even preserved my live deliberation ("? No — grounded decision:") as plan text | Rewritten: single coherent position — fork gets ONE ~30-line `simulator-stream` tool; the deliberation noise is gone (this file's §2 now states it once, cleanly) |
| F2 | 🟠 | "MJPEG-style stream **per the darwin bundle**" was an inference, not a fact — and 2.4 hedged with a dual render path to cover the guess | Verified against the binary: `stream_ready` emits an `http://` URL; endpoint is `/stream.mjpeg` serving `multipart/x-mixed-replace;boundary=NextFrame` — MJPEG **confirmed**; dual-path hedge removed, `<img>` only |
| F3 | 🟠 | Stream lifecycle unaddressed: the URL is only valid while the simulator-server process lives, and per-device spawn happens on first service resolve — a Watch session could outlive the server | Added to §2.4: wall treats stream errors as terminal for the session (not just frame-stall) → immediate pulse fallback; re-Watch re-resolves (registry initPromise caches per-URN, so repeat resolve is cheap — verified F5 in source) |
| F4 | 🟡 | tvOS guard claim ("mirror screenshot's") cites the import but not the behavior | Verified in screenshot/index.ts: guard is `device.platform === "ios" && await isTvOsSimulator(udid)` → throw; the new tool uses the identical check |
| F5 | 🟡 | G4 said "terminate the simulator-server → typed error" but the first failure mode is actually a **stale URL** (server died after URL handed out; resolve succeeded earlier) | G4 split: (a) server dead BEFORE resolve → typed error from the engine; (b) server died AFTER → `<img>` onerror fires → wall falls back to pulse. Both paths gated |
