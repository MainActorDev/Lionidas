# Replace Crucible's device-facing stack with wrapped Baguette — Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Delete Crucible's own device-control/bezel/stream-engine stack and hand the entire device-facing surface to baguette (unmodified, Apache-2.0), embedded in the wall behind a session-aware crucible proxy that keeps every existing concept (watch/drive, leases, run-holds, honest errors).

**Architecture:** Crucible server spawns/supervises `baguette serve` on loopback (same pattern as today's engine supervisor). The wall's device area becomes an **iframe** loading baguette's own sim page through a **crucible-owned reverse proxy** (`/baguette/*`). The proxy (a) strips baguette's `frame-ancestors 'none'` CSP so embedding is legal, (b) rewrites nothing else — same-origin from the wall's perspective, (c) is the **gating seam**: while a driving session is live, the proxy forwards client→baguette traffic (WS frames + POSTs) both ways; when the lease expires/session ends, the proxy drops client→server frames (input dies, video keeps flowing → the existing "control lost" UX). Crucible keeps: auth, device registry, sessions, runs, templates, evidence, forge, DB — everything NOT device-facing.

**Tech Stack:** Fastify reverse proxy (server), `baguette serve` child process (supervised, port 8422), iframe embed (wall), existing session/lease machinery untouched.

---

## Verified facts this plan is built on (evidence gathered 2026-09-10/11)

1. **Typing works in baguette** — `baguette key --code KeyH` + `baguette type --text ello` both landed in the focused Safari field (screenshots `/tmp/bk5.png`, `/tmp/bk6.png`: "hi" → "hiello"). Their AGENTS.md "external tooling" note is stale. Serve-UI keyboard = `parts/keyboard.js` focus-gated keydown → same `IndigoHIDInput.key()` HID path our engine used.
2. **`frame-ancestors 'none'`** rides `staticAsset()` (Server.swift:871-884) → **every page including sim.html**. Direct iframe is blocked; a proxy that strips the header makes it legal (the browser only sees what the proxy sends).
3. **Cross-origin WS is trusted via `--allowed-hosts <host>`** — HOST ONLY, no port (`isAllowedHost` Server.swift:3304-3310 matches `originHost` against the set; `localhost:5230` as a flag value NEVER matches). Verified: WS from `Origin: http://localhost:5230` → **400** without flag, **OPEN + 237 frames/4s (~59fps)** with `--allowed-hosts localhost`. Through the same-origin proxy the browser sends NO cross-origin headers at all, so this is belt-and-braces; we pass the flag anyway.
4. **Their client JS routes every resource URL through one seam** — `window.BaguetteTarget` (`target.js`, loaded first) + absolute-root `<script src="/target.js">` in sim.html. Through the iframe, `window.location` is OUR proxy origin, so their absolute paths resolve against our proxy — no JS patching needed, no fork.
5. **Baguette server routes needed by the sim page exist and are live**: `GET /simulators` (page), `GET /simulators.json`, `GET /simulators/:udid` (page), `WS /simulators/:udid/stream?format=avcc&version=v2`, chrome/bezel JSON+PNG routes, captures, snapshot. **Also `POST /simulators/:udid/input`** — verified live: `{"type":"tap","x":201,"y":374,"width":402,"height":874}` → `{"ok":true}`. ⚠ Wire uses **`type`** (not our `kind`), and tap/swipe carry **`width`/`height`** (device points) so the server can normalize. This route is the drop-in replacement for crucible's `engine-input.ts` (recorder taps + API gestures — see Task 1.5).
6. **Crucible inventory to retire**: `native/screenstream/` (Swift engine, ~20 files), `server/src/stream/screenstream.ts` (supervisor), `server/src/routes/stream-relay.ts` (relay; run-pause socket hooks live here — must be re-homed first), `web/src/composables/deviceStream.ts` (610 lines), `useDeviceInput.ts` (201), `useDeviceBezel.ts` (38), the stream canvas inside `DeviceSidebar.vue` + `DrivePage.vue` + `RunPanel.vue` (watch-only surfaces KEEP our own canvas — see decision D3).
7. **Engine-signature scan** (`scripts/scan-signatures.mjs`) forbids engine names in ALL text files including docs/plans — the word "baguette" must be added to its exemption or the repo name for it scrubbed to a neutral codename in all NEW files (existing memory note: engine names never appear; describe by shape). ⚠ THIS PLAN ITSELF uses the name — the in-repo copy must be written with the neutral term.
8. **License:** baguette is Apache-2.0 — spawning an unmodified binary and embedding its pages is permitted with attribution preserved (their headers/licensing stay intact; we never redistribute modified code).

## Decisions (locked)

- **D1 — Iframe + proxy, not script-embedding.** Their page is IIFE-structured with absolute-root scripts; loading it in an iframe through our proxy gives 100% of their UX (bezel, gestures, keyboard, quality controls, captures, AX inspector) with zero forks. Script-embedding their JS into our Vue app would break their `window.Baguette` assumptions and their styles.
- **D2 — Gating at the proxy, both directions.** Watch = server→client only. Drive = both. Run = detach. Baguette never learns about sessions; crucible's session model enforces itself at the network seam. This is STRONGER than today's `inputGranted` flag (which lived in our engine and acked `ok:true` into dead ports).
- **D3 — Watch-only surfaces (wall tiles, RunPanel) keep a minimal own-canvas path.** Replaced by a thin WS client speaking baguette's wire (our `codecs.ts` decode is already their dialect verbatim). RunPanel/wall tiles need a small always-on canvas INSIDE our chrome; an iframe per tile would be heavyweight and their page carries toolbars. This keeps the run-still feed (see T9) and tile previews working.
- **D4 — Baguette runs on port 8422**, spawned by a supervisor modeled on `ensureScreenstream` (lazy spawn, health probe `/simulators.json`, idle-reap 5 min, max-age recycle 2 h). Env: `BAGUETTE_WEB_DIR` unset (binary embeds resources), `--allowed-hosts localhost`.
- **D5 — run_pause/run_resume hooks re-home to the supervisor**: on run start/finish the server closes ALL proxied client→baguette WS relays for that UDID (detach = "hold"), re-attaches on finish. Their encoder emits-on-change and stops when no client reads, so detach is the hold.
- **D6 — Neutral codename in repo: `simdeck`** (all new files, env vars `CRUCIBLE_SIMDECK_*`). The scan-pattern list gains nothing; the name "baguette" must not appear in crucible files. The pinned source stays in ITS own repo next door (`../baguette`) — crucible references only paths + the codename.

## What is explicitly KEPT (user requirement)

| Concept | Where it lives after | Change |
|---|---|---|
| Device registry/tiles, boot/shutdown, power route | `poll/devices.ts`, wall tiles | none |
| Watch vs drive, lease, heartbeat, idle reap, control-lost banner | `manual/session.ts`, sidebar | none (gating moves to proxy) |
| Runs, playback, templates, evidence, forge, matrix | untouched | none |
| Bezel quality | baguette's chrome (replaces ours) | better (their farm of bezels) |
| Stream quality controls | baguette's sidebar (scale/fps/bps presets) | better (persisted presets) |
| Inspect mode | **baguette's AX inspector** replaces ours (`sim-ax-inspector.js`) | feature-equal (verify in Phase 0) |
| Typing | baguette keyboard + paste/copy bridge | **better** (paste/copy we never had) |
| Run-still feed during runs | re-implemented on baguette's `snapshot` route (T9) | same UX |

---

## Phase 0 — Spike: embed ONE sim, drive it, feel it (decision gate, ~2 h)

**Goal:** prove the iframe+proxy embed works end-to-end BEFORE any deletion. If this fails, nothing else runs.

### Task 0.1: Spike proxy (throwaway script, not shipped)

**Files:**
- Create: `/tmp/simdeck-spike/proxy.mjs` (node, no deps beyond `http`)

**Step 1:** Write a minimal reverse proxy: `http://127.0.0.1:9231/simdeck/*` → `http://127.0.0.1:8422/*`, stripping `content-security-policy` response headers, passing everything else (incl. WS upgrade — use the `ws`-style manual upgrade pipe from crucible's `server/node_modules/ws`).

```js
// /tmp/simdeck-spike/proxy.mjs — throwaway spike, not production shape
import http from 'node:http';
import { WebSocketServer } from '/Volumes/berkakyo/Users/berkamain/Developer/w0rk/lionparcel/ai/crucible/server/node_modules/ws/index.js';

const TARGET = '127.0.0.1'; const TPORT = 8422;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname.replace(/^\/simdeck/, '') || '/';
  const proxied = http.request({ host: TARGET, port: TPORT, path, method: req.method, headers: { ...req.headers, host: `${TARGET}:${TPORT}` } }, (up) => {
    const h = { ...up.headers };
    delete h['content-security-policy'];           // THE embed unlock
    res.writeHead(up.statusCode, h); up.pipe(res);
  });
  proxied.on('error', () => { res.writeHead(502); res.end('simdeck upstream down'); });
  req.pipe(proxied);
});
// WS upgrade: manual bidirectional pipe
server.on('upgrade', (req, sock, head) => {
  const path = new URL(req.url, 'http://x').pathname.replace(/^\/simdeck/, '');
  const key = req.headers['sec-websocket-key'];
  const headers = `GET ${path} HTTP/1.1\r\nHost: ${TARGET}:${TPORT}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`;
  const up = net.connect(TPORT, TARGET, () => { sock.write(headers); up.write(head); });
  sock.pipe(up); up.pipe(sock);
  // raw TCP pipe = frames pass through unmodified both directions
});
import net from 'node:net';
server.listen(9231, '127.0.0.1', () => console.log('spike proxy on 9231'));
```

**Step 2:** Start baguette + proxy:

```bash
cd ../baguette && (./Baguette serve --port 8422 --allowed-hosts localhost > /tmp/simdeck.log 2>&1 &)
node /tmp/simdeck-spike/proxy.mjs   # background, verify with curl
curl -s -D - -o /dev/null http://127.0.0.1:9231/simdeck/simulators | grep -iE "200|content-security"   # expect: 200, NO CSP header
```

**Step 3:** Minimal host page:

```html
<!-- /tmp/simdeck-spike/host.html — serve via python3 -m http.server in that dir, open in the user's Chrome -->
<!doctype html><meta charset="utf-8"><title>spike</title>
<style>html,body{margin:0;height:100%;background:#000}iframe{border:0;width:100vw;height:100vh}</style>
<iframe src="http://127.0.0.1:9231/simdeck/simulators/835EE2B0-311F-4A79-B377-A0C0FE8C9FD9"></iframe>
```

### Task 0.2: Spike checklist (the decision gate)

Run through in a REAL browser (browser_exec), each item pass/fail:

1. sim page renders inside the iframe (bezel + stream visible) — CSP strip works.
2. **Typing**: focus their screen, type into a sim text field → chars appear. (Already proven at CLI level; this verifies the iframe keyboard-focus path specifically.)
3. **Wheel/tap/drag** on the iframe stream → device responds (pixel-diff screenshots). ⚠ Synthetic events must be **MouseEvent mousedown/mouseup** — their gesture source binds mousedown; PointerEvent dispatches land nothing (live finding). Keyboard: dispatch on their canvas element after a real tap focuses it.
4. Stream fps reads ~60 during motion (their own fps pill).
5. **Second browser tab** opens the same page read-only-ish (baguette has no gating — both tabs CAN drive; note as expected; crucible's proxy fixes this later).
6. **Sim reboot**: shutdown+boot the sim from terminal with the iframe open → does their page recover honestly (error/loading state)? Record behavior for T7 mapping.
   ⚠ **MEASURED (2026-09-11 spike)**: their page's VIDEO recovers automatically after a sim reboot (0→60 fps unattended) but their page's INPUT stays silently dead — page taps land nothing while the stream plays (their gesture path keeps a stale session; baguette's own `POST /input` HTTP route still works fine post-reboot). A page RELOAD fixes input. **This is the same bug class as our engine's 00fcbea (ok:true into the void) — they fixed the stream, not the input.** Crucible handling: our wall host can detect reboot via `/simulators.json` state polling and force an iframe reload (cheap, ~2s), OR detect first-grant-tap failure and reload once. Goes into Task 1.4 as the reboot-resilience behavior. NOT a blocker: their HTTP route covers crucible's own dispatch needs (recorder taps, playback).
7. **Sim death**: `xcrun simctl shutdown` and leave it → their page state after 30 s? (feeds T7).
   ⚠ **MEASURED (2026-09-11 spike)**: their page FREEZES the last frame and keeps showing "60 fps" with the sim shut down — the frozen-frame-lie our `stream_died` work eliminated. Crucible handling (E4): the wall HOST polls `/simulators.json` (or our own devices mirror, already 2s-cadence) and overlays our honest "device shut down — stream ended" banner on the iframe + greys it. Their page cannot be made honest without a fork; our host wrapper supplies the honesty.
8. Quality controls work through the proxy (click their Balanced preset → fps/scale pill changes).
9. Captures/snapshot button produces a capture through the proxy.

**Gate:** items 1–4 pass → proceed. Item 1 fails → CSP strip insufficient (inspect actual headers; Safari is stricter — test Chrome first, note Safari). Items 6–7 fail → map their failure UX in T7 (their page shows *something* — we frame it with our own banner if it's a spinner-lie).

---

## Phase 1 — Supervisor + proxy (server-side, TDD)

### Task 1.1: `server/src/simdeck/supervisor.ts` — spawn/health/reap

**Files:**
- Create: `server/src/simdeck/supervisor.ts`
- Test: `server/src/simdeck/supervisor.test.ts`

Model exactly on `stream/screenstream.ts` (same contract, different binary/health route):

```ts
// supervisor.ts
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const BIN = process.env['CRUCIBLE_SIMDECK_BIN']
  ?? join(__dirname, '../../../baguette/Baguette');   // sibling repo, pinned by checkout
const PORT = Number(process.env['CRUCIBLE_SIMDECK_PORT'] ?? 8422);
const IDLE_REAP_MS = 5 * 60_000;
const MAX_AGE_MS = 2 * 60 * 60_000;

let proc: ReturnType<typeof spawn> | null = null;
let spawnedAt = 0;
let lastNeededAt = 0;
let ready: Promise<number> | null = null;

export async function ensureSimdeck(): Promise<number> {
  lastNeededAt = Date.now();
  if (proc && Date.now() - spawnedAt < MAX_AGE_MS) {
    const ok = await health().catch(() => false);
    if (ok) return PORT;
  }
  // (re)spawn: kill stale, start fresh — see screenstream.ts for the full
  // rejected-promise-never-caches pattern; copy it verbatim
  ...
  proc = spawn(BIN, ['serve', '--port', String(PORT), '--allowed-hosts', 'localhost'], { stdio: 'pipe' });
  // health probe: GET http://127.0.0.1:PORT/simulators.json (200 = ready)
}
```

**Tests (vitest, fake binary = a node script that serves 200 on /simulators.json):**
- returns port when healthy; spawns when absent; respawns when health fails; rejects (permanent class) when `CRUCIBLE_SIMDECK_BIN` missing — mirror the four cases `screenstream.test.ts` covers.
- idle-reap: `setInterval` advancing past `IDLE_REAP_MS` with no `ensure` calls → child killed (use fake timers; assert kill called).

**Verify:** `pnpm vitest run simdeck/supervisor` — green.

### Task 1.2: `server/src/simdeck/proxy.ts` — the gated reverse proxy

**Files:**
- Create: `server/src/simdeck/proxy.ts`
- Test: `server/src/simdeck/proxy.test.ts`

Fastify route `app.all('/simdeck/*')` + `app.get('/simdeck/*', {websocket: true})`:

- **HTTP leg**: proxy to `127.0.0.1:8422`, strip `content-security-policy` from the response, pass through everything else. Cookie `crucible` session REQUIRED (401 otherwise) — the simdeck surface is authed like every /api.
- **⛔ Origin rewrite is MANDATORY on BOTH legs** (Phase 0 live finding): baguette's origin check (`Server.swift` request-origin trust) requires `originPort == requestPort`. The proxy rewrites `Host` to `:8422`, so a browser `Origin: http://…:9231` mismatches → **400 on the stream WS** and the page sits at "0 fps" forever (no visible error). Verified fix: rewrite `Origin` to `http://127.0.0.1:8422` on upgrade → WS opens, 131 frames/4s. Test: proxied WS with browser-shaped Origin header opens and streams; without rewrite asserts 400.
- **WS leg** (the stream + their control WS): bidirectional pipe with a **mode gate**:

```ts
type Mode = 'drive' | 'watch';
// resolved per-connection from crucible state at CONNECT time:
//   live manual session held by THIS operator for the iframe's udid → 'drive'
//   otherwise → 'watch'
// watch: pipe upstream→client frames; DROP client→upstream TEXT frames (gestures are
//   JSON text on their WS). Binary client frames don't exist on their control path.
// drive: pipe both directions. On session finish/lease-expire mid-connection:
//   flip to watch + send our typed notice '{"type":"crucible_control_lost"}' —
//   the wall's iframe host page listens for postMessage from the iframe? NO —
//   simpler: the wall HOST (outside iframe) already shows the control-lost banner
//   via its own /api/events subscription. The proxy just silently drops frames.
```

- **Run-hold hooks**: `bus.on('run.started')`/`run.finished'` for a udid with proxied connections → close ALL client legs for that udid (detach; wall host shows "run in progress" overlay it already has).

**Tests:**
- watch mode: text frame client→upstream is dropped (spy on upstream socket .write), binary upstream→client passes.
- drive mode: both directions pass.
- mode flip on synthetic session-finish event: subsequent client text frames dropped, connection stays open (video continues).
- run.started for udid: client legs closed; upstream untouched (baguette keeps serving).
- CSP strip: response headers pass through WITHOUT `content-security-policy`.
- no-cookie: 401.

**Verify:** `pnpm vitest run simdeck/proxy` — green.

### Task 1.5: Re-point `engine-input.ts` at simdeck's `POST /simulators/:udid/input`

**Files:**
- Modify: `server/src/manual/engine-input.ts` — replace the engine-WS transport with `fetch('http://127.0.0.1:8422/simulators/:udid/input', {method:'POST', body})`. **Wire translation in ONE place**: our `{kind:'tap', x, y}` → their `{type:'tap', x, y, width, height}` (dims from the session's `logicalW/logicalH`; swipe maps `startX/…/endY` + dims; key maps `code`+`modifiers`; scroll `deltaX/deltaY`). ⚠ their key = `type` not `kind`; missing width/height on tap/swipe = their parse error (`missing field` observed live).
- Test: extend `engine-input` tests — translation table (our kind → their type + dims), ack-shape `{ok:boolean}`, connect-failure → throws (existing `engineInputWithFallback` alloy fallback keeps working).

**Why this matters (self-review catch):** `manualTap` (session.ts:173) and `manualGesture` dispatch ALL recorder taps + step-playback gestures through `engineInput()`. Deleting engine-input without this breaks the QA recorder and playback. This task is what keeps "record → template → replay" alive across the swap.

**Verify:** `pnpm vitest run manual` — green.

### Task 1.3: Wire supervisor+proxy into the app (runs AFTER 1.5 — see ordering note)

**Files:**
- Modify: `server/src/index.ts` (register routes, same registration block as stream-relay)
- Modify: `server/src/routes/devices.ts:80-100` — `POST /api/devices/:udid/stream` now ALSO calls `ensureSimdeck()` (fail-soft: simdeck failure must NOT break existing resolve until Phase 3 deletes it) and returns `{ simdeckUrl: '/simdeck/simulators/<udid>' }` alongside the legacy `streamUrl`.

**Test:** route test asserting both fields present with a fake supervisor seam (`__setSimdeckEnsureForTest`).

**Verify:** `pnpm vitest run` (whole suite — no regressions), then live: start stack, `curl -b cookies -X POST localhost:9230/api/devices/835.../stream` → both URLs.

### Task 1.4: Wall embed — DeviceSidebar drive surface swaps canvas → iframe

**Files:**
- Modify: `web/src/components/DeviceSidebar.vue` — in the stream stage, when `sessionActive && simdeckUrl`: render `<iframe :src="simdeckUrl + '?embed=1'">` (note: `?embed=1` is inert to baguette — unknown query is ignored; it's OUR marker, reserved in case we later ask upstream for a chrome-lite mode). Keep the existing canvas as fallback while `simdeckUrl` is absent (Phase 2 removes it).
- The sidebar's own controls (take/release control, finish, heartbeat) stay — they act on crucible sessions; the iframe just becomes the device surface.
- Watch tiles on the wall page (small canvases) KEEP the current canvas path (D3) until T2.1.

**Verify (live, authed browser via browser_exec):**
1. drive → iframe loads, bezel+stream render (CSP stripped by our proxy).
2. typing in a field through the iframe works.
3. tap/wheel through iframe works (pixel-diff).
4. click "finish" (session ends) → banner shows control lost; iframe still streams (watch mode at proxy).
5. `vue-tsc` + `oxlint` clean.

**Commit:** `feat(simdeck): embed device surface via gated proxy (phase 1)`

---

## Phase 2 — Watch surfaces + evidence paths migrate

### Task 2.1: Thin watch client speaks baguette's wire (`web/src/composables/simdeckWatch.ts`)

**Files:**
- Create: `web/src/composables/simdeckWatch.ts`
- Test: `web/src/composables/__tests__/simdeckWatch.test.ts`

Reuse `stream/codecs.ts` UNCHANGED (it decodes their envelope verbatim — tags 1/2/3/4, avcC, IDR, delta, JPEG seed). New composable: connect WS `wss?://host/simdeck/simulators/:udid/stream?format=avcc&version=v2` (through the same proxy → auth cookie rides, watch mode enforced server-side), feed `makeAvccDecoder`, paint to canvas (native-size blit — the shape already shipped). No input leg at all.

**Tests:** decode-path unit test with a canned avcC+IDR+delta sequence (exists in codecs tests — extend for the URL/mode shape).

**Verify:** wall tiles + RunPanel render live previews again.

### Task 2.2: run-still feed re-homed

**Files:**
- Modify: `server/src/routes/stream-relay.ts` — the run-still pump (`simctl io screenshot` stills fan-out) re-targets from engine sockets to simdeck client legs: on each still, push as a JPEG-seed-tagged binary frame (tag `0x04` + JPEG — baguette's own seed envelope, so both our watch canvas AND any iframe show it).

**Verify:** start a run against a booted sim → wall tile + run panel show the still frames during the run (existing drill: run → watch panel frame advances).

### Task 2.3: Inspect mode switch

**Files:**
- Modify: `web/src/components/DeviceSidebar.vue` + `web/src/pages/DrivePage.vue` — remove our InspectOverlay mount on the drive surface (baguette's AX inspector panel replaces it; verify Phase 0 item: their inspector exposes frames/labels and a tap action).
- `useInspectTree.ts` + `/tree` routes: KEEP (they power our own sweep/probe machinery for playback — not part of the device-facing surface).

**Verify:** drive page shows their inspector; our sweep playback tests still green (`pnpm vitest run`).

**Commit:** `feat(simdeck): watch surfaces + run-still + inspect migration (phase 2)`

---

## Phase 3 — Deletion (the payoff)

⛔ **Deletion dependency check first** (per plan-skill rule): for EACH file below, `grep -r` every exported symbol across `server/` + `web/` and list references; anything still referenced is deferred, not deleted.

### Task 3.1: Delete the Swift engine + supervisor + relay

- Delete: `native/screenstream/` (whole tree, ~20 files).
- Delete: `server/src/stream/screenstream.ts` (+test).
- Delete: `server/src/routes/stream-relay.ts` — EXCEPT first extract into `server/src/simdeck/holds.ts`: the run-hold event wiring (bus → close client legs) already re-homed in T1.2; delete the rest (engineSockets, pumpUpstream, drain, OUTAGE_CLOSE_MS...).
- Delete: `server/src/manual/engine-input.ts` (grants to a dead engine).
- Modify: `server/src/routes/devices.ts` — `POST /api/devices/:udid/stream` returns ONLY `{ simdeckUrl }`; remove legacy `streamUrl`+`format` fields; update route tests.
- Modify: `web/vite.config.ts` — remove `/screenstream` proxy.
- Modify: `web/src/composables/deviceStream.ts` — DELETE (610 lines); all consumers now use simdeckWatch (wall tiles, RunPanel) or the iframe (drive). ⛔ verify zero imports remain first.
- Delete: `useDeviceInput.ts` (201), `useDeviceBezel.ts` (38), `stream/codecs.ts` MOVED into `simdeckWatch.ts` path or kept as `web/src/composables/stream/codecs.ts` if simdeckWatch still imports it (it does — keep codecs, delete the rest of deviceStream).

**Verify after deletion:** `pnpm typecheck && pnpm lint && pnpm scan && pnpm vitest run` (server) + `npx vue-tsc --noEmit && npx vite build` (web) — ALL green with the files gone. Then LIVE drill: boot → drive → type → scroll → snapshot → finish → run a template → evidence intact.

**Commit:** `feat(simdeck)!: retire first-party engine — baguette is the device surface (phase 3)`

### Task 3.2: Docs + skill update

- Modify: crucible SKILL.md — the device-live-stream section rewritten to the simdeck shape; `references/screenstream-*.md` marked superseded (kept for history).
- Modify: `docs/plans/` — this plan + a decision record (why wrap, why not C).
- Verify: `pnpm scan` green (codename discipline).

---

## Phase 4 — Hardening (post-verification, can slip)

- T4.1 Supervisor restart drill: `kill -9` the baguette child mid-drive → wall shows honest reconnect (proxy 502 → host page banner), supervisor respawns ≤5 s, iframe reloads.
- T4.2 Idle-reap + max-age recycle drill against the real child.
- T4.3 Safari iframe check (CSP-strip behavior is per-browser; Chrome first-class, Safari verify — note any strictness in the plan retro).
- T4.4 Remote-wall path: browser on another machine → proxy is same-origin to the WALL (5230→9230 via vite) so simdeck rides the vite proxy hop transparently; verify one remote browser.
- T4.5 Baguette version pin: `../baguette` checkout pinned by commit hash in `docs/plans/` decision record + a startup log line printing `baguette --version` output (**current pin: `0c1b52b`, version 0.1.61, clean tree at pin time**); upgrades = checkout new commit → run Phase 0 checklist.

---

## EDGE-CASE TABLE (user directive: analyze edge cases)

| # | Edge | Behavior today | Behavior in plan | Where handled |
|---|---|---|---|---|
| E1 | Operator closes browser mid-drive (lease held) | idle watchdog finishes session after 5 min | same — proxy legs die with the socket; session machinery untouched | existing `session.ts` |
| E2 | Server restart while driving | sessions orphaned; honest 410 on next call; sidebar banner | same; iframe host page re-resolves simdeckUrl on remount | existing + T1.4 fallback path |
| E3 | Sim reboot mid-drive | (was the tap-death bug; engine fixed 00fcbea) | baguette's own behavior — Phase 0 item 6 measures it; whatever it is (recover or error state), our banner wraps it | T0.2, T7-mapping in T1.4 |
| E4 | Sim shutdown (death, not reboot) | stream_died → honest error | baguette's page state — Phase 0 item 7; if it spinner-lies, host page detects `/simulators.json` state=Shutdown via poll and overlays OUR banner | T0.2 |
| E5 | Two operators, one drives, second watches | wall shows "someone else is driving" | second operator's iframe connects in watch mode (proxy drops their gesture frames); both see video | T1.2 mode gate |
| E6 | Run starts while an operator is driving | engine got run_pause; stream froze honestly | proxy DETACHES legs (video drops to run-still via T2.2); drive page shows run overlay | T1.2 run hooks + T2.2 |
| E7 | Baguette child crashes | n/a (our engine) | proxy 502 → iframe host banner "device surface unavailable — retrying"; supervisor respawn ≤5 s; auto-reload on health | T4.1 |
| E8 | Physical device (kind=device) | 422 SIM_ONLY | unchanged: stream route 422s before any simdeck spawn | devices.ts guard stays |
| E9 | Fresh machine, `../baguette` not built | engine 503 permanent class | supervisor rejects with `simdeck binary not found (build ../baguette or set CRUCIBLE_SIMDECK_BIN)` — same permanent/transient classes as today | T1.1 |
| E10 | Engine-signature scan | forbids names | codename `simdeck` everywhere; `pnpm scan` in CI keeps it honest | T3.2 |
| E11 | Baguette pushes a breaking change | n/a | pinned commit (T4.5); upgrade = re-run Phase 0 checklist; their apiVersion discipline (plugins) suggests wire stability | T4.5 |
| E12 | Iframe keyboard steals host shortcuts | n/a | baguette's keyboard is FOCUS-GATED to their screen element (verified in keyboard.js) — host shortcuts live outside the iframe focus | Phase 0 item 2 |
| E13 | Cookie expires mid-session | fetch 401 interceptor redirects | iframe WS legs simply die (baguette conn drops); host page's existing 401 handling catches the api calls; re-login → remount | T1.2 (no special case — verify in drill) |
| E14 | Wall served over https (colony deploy) | direct-WS races ws/wss | proxy is same-origin — no mixed-content; the vite-proxy hop covers remote browsers | T4.4 |

## Risks / open questions

- **R1 — Iframe focus quirks** (click into iframe then host keys go to sim): baguette's focus gating handles their side; if HOST shortcuts get eaten while iframe holds focus, click-outside is the escape — measure in Phase 0 item 2; acceptable.
- **R2 — Their page chrome (sidebars/toolbars) inside our sidebar** may feel heavy at small widths. `?embed=1` marker reserved to request a chrome-lite mode upstream later; today full chrome = feature gain (quality presets, captures, inspector).
- **R3 — Watch-mode UX**: dropped gesture frames get NO ack in baguette's UI (their client sends fire-and-forget) → a watching operator sees nothing happen, which is correct (read-only) but silent; our host banner already says "watching · read-only".
- **R4 — Baguette's `--allowed-hosts localhost`** trusts ANY localhost-origin page. Our proxy strips the Origin/Host to the baguette bind host anyway (spike proxy rewrites Host); direct-to-8422 from another localhost page remains possible — acceptable on a dev Mac; note in decision record.
- **R5 — simdeck on a machine where the sibling repo moves** → `CRUCIBLE_SIMDECK_BIN` env override (same as today's engine bin env).

## What we stop doing (the point of all this)

- Owning a HID/VT/watchdog Swift engine (every bug class of the last 48 h lived there).
- Chasing baguette's client pipeline parity forever.
- Maintaining bezel assets + chrome geometry.

## Verification gates (every phase)

```bash
cd ai/crucible/server && PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH" pnpm typecheck && pnpm lint && pnpm scan && pnpm vitest run
cd ai/crucible/web && npx vue-tsc --noEmit && npx oxlint src/ && npx vite build
```

Live drills per phase as listed in tasks. Final acceptance: the full manual journey (boot → drive → type → wheel → snapshot → finish) + one template run with evidence, entirely through the simdeck surface, feeling like baguette — because it is.
