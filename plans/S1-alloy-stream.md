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

### 2.1 Engine-B fork — no change required

The blueprint already resolves the service lazily and returns `streamUrl`. Resolving it via an existing tool is enough — a new engine tool would only wrap `registry.resolveService`. **We do NOT touch the fork**; we use its existing service resolution from Alloy's adapter, same as screenshots do. (If `describe`/`screenshot` can resolve the service, so can a stream query.)

### 2.2 Alloy — `alloy_stream` tool (new routing row)

```
routing: { tool: 'alloy_stream', engine: 'B', lease: 'per-call',
  schema: { udid } }
```

Handler (adapter-b call): the existing engine tool that forces service resolution for a device is `screenshot` — but it captures a PNG (wasteful). Instead: add a **generic service-probe** to adapter-b: call `native-devtools-status` (cheap, resolves services for the device)? No — grounded decision: the screenshot tool resolves `simulatorServerRef`; the cheapest existing resolver without side-effect capture is **`describe`** (it resolves AX for the foreground app of the same device session). But `describe` output does not include streamUrl.

**Therefore the fork DOES need one minimal addition** (correcting §2.1 after grounding): a `simulator-stream` tool in the fork's `tool-server/src/tools/` that does exactly the 3-line resolve + return:

```ts
// tools/simulator-stream/index.ts (new, mirrors screenshot's resolve pattern)
const ref = simulatorServerRef(device);
const api = (await registry.resolveService(ref.urn, ref.options)) as SimulatorServerApi;
return { streamUrl: api.streamUrl, platform: device.platform };
```

Registered in the fork's `utils/setup-registry.ts`. Schema: `{ udid }`. Capability: iOS simulator only (mirror the screenshot tool's tvOS guard). ~30 lines total, PR to our own fork — not upstream-blocked.

### 2.3 Alloy facade

- routing row `alloy_stream` (engine B, per-call lease — read-only, watching ≠ holding)
- registrations: `callBTool(client, 'simulator-stream', { udid })`, pass through `{streamUrl, platform}`
- degraded-safe: engine error → structured AlloyError; Crucible falls back to pulse

### 2.4 Crucible — Watch upgrade

- Wall tile Watch: call `POST /api/devices/:udid/stream` (new route → alloy_stream) → get `streamUrl` → render `<img :src="streamUrl">` (MJPEG renders natively in img tags; if the stream is raw WS video, `<video>`/MSE — detect by URL scheme, both paths shipped)
- **Fallback ladder**: stream fetch fails OR stalls (no frame in 10s) → revert to screenshot-pulse automatically, badge "pulse" so the operator knows
- Keep lease semantics: stream watch takes NO lease (unchanged)
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
G4 terminate the simulator-server → alloy_stream returns typed error; Watch falls back to pulse automatically
G5 full Alloy suite still green (routing-table held-set unchanged: per-call)
```

## 5. Risks

| Risk | Mitigation |
|---|---|
| streamUrl format is MJPEG vs raw WS | G2 detects actual format; both render paths shipped in 2.4 |
| Long-lived stream connections exhaust server | Watch polls alloy_stream ONCE per watch session, then holds the URL; browser owns the connection lifecycle |
| Stream keeps simulator-server alive after watch closes | No change: service lifecycle is the engine's registry refcount, same as screenshots today |
