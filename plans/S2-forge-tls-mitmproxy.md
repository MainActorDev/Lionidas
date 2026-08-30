# PLAN — S2: Forge TLS via mitmproxy integration

**Status: READY — awaiting approval. Replaces the NO-GO misread: "toolchain absent" ≠ "infeasible". We integrate a mature MITM proxy as Forge's HTTPS path — composition, not reinvention.**

Repos: `ai/crucible` (+ `brew install mitmproxy` on the host) · Duration: ~1 day

## 0. Principle

**mitmproxy owns the crypto; Forge owns the semantics.** We do not write one line of TLS, CA, or certificate-trust code. mitmproxy's scriptable addons are its first-class extension point — Forge becomes one addon that maps its preset/scenario model onto mitmproxy's request lifecycle.

## 1. What this unlocks (current honest state)

- Today Forge intercepts HTTP only (DEV base-URL targets). Real apps speak HTTPS to staging/production — currently passed through untouched.
- With MITM: **all endpoints become presettable** — including third-party APIs, staging, and prod-shaped traffic — through the exact same presets/scenarios/traffic UI that exists now.

## 2. Architecture

```
app (DEV build, no proxy config needed)     mitmproxy (host process)          real network
  ── HTTPS ──────────────────────────────▶  │ addon: forge_router.py  │ ─────▶─ upstream
        ▲                                  │  reads scenario.json    │
        ◀─ preset response OR real ────────│  writes traffic.ndjson  │
```

- **Device wiring — decision tree (self-review F1; mechanism PROVEN at G0 before integration code):**
  1. `xcrun simctl spawn <udid> launchctl setenv HTTPS_PROXY http://127.0.0.1:<port>` (2-arg setenv via the sim's launchd) — candidate; verify an app's NSURLSession actually honors it on a booted sim
  2. If (1) fails: per-device settings automation (our own DrivePage/manual flow toggles the proxy in Settings once per device, persisted per-sim)
  3. If both unsuitable: **base-URL swap** — DEV build config pointed at `http://127.0.0.1:<port>` (the mechanism Forge's HTTP path already uses); MITM still terminates TLS to real upstreams. Unmodified-app coverage degrades to nothing, and that limitation is recorded, not hidden
  Chosen mechanism is applied per-run by the dispatcher and reverted in `finally`.
- **Trust**: mitmproxy's CA (`~/.mitmproxy/mitmproxy-ca-cert.pem`) installed into the simulator's trust store per device: `xcrun simctl <udid> spawn booted trustanchor add ...`? — grounded correction: iOS sims honor **host keychain user-added roots**; install once per host via `security add-trusted-cert -d -r trustRoot -k ~/Library/Keychains/login.keychain-db ~/.mitmproxy/mitmproxy-ca-cert.pem` (human-run setup step, LaunchAgent-law style: we prepare a `.command`, the user double-clicks once).

### 2.1 The addon — `server/src/forge/mitm/addon.py`

Single-file mitmproxy addon, spawned and managed by the Crucible server:

```python
# loaded via: mitmdump -s addon.py --set confdir=~/.mitmproxy
class ForgeRouter:
    def load(self, loader):          # conf: state_dir
    def request(self, flow):         # match against active scenario presets
        #   hit → flow.response = preset response (status/headers/body/delay/seq/failure)
        #   miss → pass through (hybrid) / 501 (intercept)
    def response(self, flow):        # append traffic row (ndjson line: method/host/path/status/latency/sha)
```

- **State contract**: the addon reads a small JSON file the Crucible server writes (`forge-mitm-state.json`: mode + enabled presets, content-hashed — same immutable-once-run semantics as scenarios) and appends traffic rows to `traffic.ndjson`. The server tails the ndjson into the SQLite `traffic` table + WS fan-out (same `forge.traffic.hit` events as the HTTP proxy — one UI, two transports).
- **Shared matcher rules, two transports**: the JS matching RULES (exact/glob/regex, longest-path-wins, guards) are ported ONCE into the addon (Python); a cross-implementation contract test pins both sides to the same winner for the same fixtures. **Seq cursors are transport-scoped by design** (a run pins ONE transport — http OR mitm — never both), so cursors cannot double-advance; request matching never reads request bodies (guards are method/path/query/headers only), and response preset bodies >256KB serve from file without in-memory copies.
- **Failure presets**: timeout (`flow.response = None` + ctx timeout pattern), reset (drop connection), malformed (raw bytes body), throttle (rate-limit the response body write).

### 2.2 Server integration — `forge/mitm/manager.ts`

- Lifecycle: `startMitm()` spawns `mitmdump -s addon.py --set state_dir=... -p <port>` (loopback); health = process liveness + mitmdump's listen line on stdout; `stopMitm()` SIGTERM + wait (traffic lines flushed).
- **Per-run wiring in the dispatcher** (the run-integration that already exists, extended): scenario run starts → activate scenario (existing route) + `simctl spawn launchctl setenv HTTPS_PROXY` → run → finally: unset env + deactivate. Global simulator proxy never persists past the run (the §15.4 isolation concern, honored by construction).
- Mode parity: `record` (pass-through + log), `hybrid` (default), `intercept` — same three modes as the HTTP proxy; the addon honors whichever the state file says.

### 2.3 UI

Zero new surfaces — the existing Forge page (traffic table, presets, scenarios, freeze) serves both transports. One addition: a `transport: 'https-mitm' | 'http'` tag on traffic rows + a connection badge (`mitm: running · pid N · port P` / `mitm: stopped`).

## 3. Production-grade requirements

- **No frame loss on stop**: traffic ndjson is append-only; ingestion is idempotent (row id = hash) — server restart re-tails from offset, zero loss
- **Crash safety**: mitmproxy death mid-run → run's finally unsets the proxy env (app degrades to direct connections, no hangs), traffic tail notices process exit, badge flips to stopped, next run restarts it
- **Cert discipline**: CA install is a documented human step (`.command` file, per LaunchAgent-law Convention 35); addon never modifies trust
- **Security surface**: mitmproxy binds 127.0.0.1 only; state dir 0700; no remote admin; CA remains host-scoped
- **Upgrade story**: mitmproxy pinned via brew; addon API surface used is `request`/`response`/`load` only — the stable, documented core

## 4. Tests (named, all required)

| File | Asserts |
|---|---|
| `test/forge.mitm.matcher.test.ts` | cross-implementation fixtures: same URL sets → same winner as JS matcher (both run, outputs compared) |
| `test/forge.mitm.manager.test.ts` | spawn/health/stop lifecycle; state-file write (hash, immutability); restart re-tail (offset) idempotent |
| `test/forge.mitm.e2e.test.ts` (live) | real mitmdump + curl-through-proxy: preset hit (201 w/ body), miss passthrough to a local upstream, seq 200→500, malformed body |
| device gate (below) | real simulator app + HTTPS through MITM |

## 5. GATE (live)

```
G0 brew install mitmproxy (record exact version; addon targets stable request/response/load API); CA .command installed (human step); G0b device-proxy mechanism from the §2 decision tree PROVEN live (1, else 2, else 3 — choice recorded)
G1 preset on an https:// URL → curl via proxy gets preset response (TLS re-encrypted)
G2 miss → real upstream response passes through (hybrid default)
G3 real simulator app (consumer DEV) via the G0b-chosen mechanism → traffic rows show DECRYPTED https paths in the Forge UI (conditional: if staging needs auth/VPN, the local HTTPS fixture upstream from e2e stands in — recorded)
G4 scenario seq preset → app retry observed in traffic (200→500→500)
G5 kill -9 mitmdump mid-run → app continues (direct), badge 'stopped', next run restarts cleanly
G6 cross-matcher fixtures green (JS and Python agree on all cases)
```

## 6. Risks

| Risk | Mitigation |
|---|---|
| Certificate pinning in some app blocks MITM | Out of FailScope: pinned apps fall back to direct (hybrid semantics still correct); documented as a known limitation, traffic shows `TLS passthrough` rows |
| Cross-language matcher drift | Contract fixtures run both implementations in CI (G6) |
| Host-wide env leak if crash before finally | Watchdog double-check: any run finishing with proxy env set → unset + warn (cheap belt-and-braces on top of finally) |
| mitmproxy perf under video-size bodies | Not on the path for media by default: large content-types stream pass-through (addon skips buffering >256KB bodies for preset match — match on headers/path only for those) |


## 7. Self-review findings (2026-08-30, applied)

| # | Sev | Finding | Resolution |
|---|---|---|---|
| F1 | 🔴 | **`launchctl setenv HTTPS_PROXY` does not exist as written** — `setenv` takes exactly 2 args (name value); my line had the `booted` device name wedged in (`spawn booted launchctl setenv ...`). Worse: `xcrun simctl spawn <udid> launchctl setenv` sets it in the **simulator's own launchd** — but iOS apps' NSURLSession reads proxy config from the **simulated OS settings**, not launchctl env. Correct mechanism per simctl: there is none for proxy env — the supported path is `simctl`'s per-device **status-bar/privacy style commands do NOT cover proxy**; the working, documented approach is `xcrun simctl spawn <udid> defaults write /Library/Preferences/com.apple.networkd ProxyHTTPEnable...`? — no. **Grounded fix:** test both candidate mechanisms at G0-time (launchctl setenv via simctl spawn; Apple's documented Simulator per-device proxy via `Settings` automation through our own DrivePage/manual flow), and if neither works for unmodified DEV builds, scope S2 to **base-URL swap** (the DEV build's own config pointed at `http://127.0.0.1:<port>` — same mechanism Forge's HTTP path already uses, MITM still handles TLS to real upstreams). Plan now carries the decision tree; G0 verifies before any build | Rewrote §2 device-wiring to the decision tree; added G0b gate: proxy mechanism proven (env, settings-automation, or base-URL) before integration code starts |
| F2 | 🔴 | Preserved my mid-plan deliberation again ("health-checks `/cmd`… grounded: checks...") — stream-of-consciousness in a spec | Cleaned: health = process liveness + readiness line on stdout (mitmdump prints its listen line); stated once |
| F3 | 🟠 | Seq cursors live in the **Python addon** (per process), but the JS matcher's cursors are per-Crucible-process — the same preset sequencing through BOTH transports would double-advance | Stated: seq cursors are transport-scoped by design (a scenario pins ONE transport per run — runs pick http OR mitm, never both); contract test pins matching only, cursor state stays per-transport. Added to §2.1 |
| F4 | 🟠 | "match on headers/path only" for >256KB bodies contradicts presets whose guards need bodies? — guards are query/header only (design §15.1); bodies are responses. No conflict, but the sentence implied request-body matching | Clarified: request matching NEVER reads bodies (guards are method/path/query/headers); the 256KB rule is about response preset bodies (serve from file, no in-memory copy) |
| F5 | 🟡 | G3 depends on the consumer DEV app's real endpoints being reachable; staging may need auth/VPN | G3 marked conditional: if staging unreachable, use a local HTTPS test upstream (same fixture server as forge.mitm.e2e) — gate honesty preserved |
| F6 | 🟡 | brew pin: mitmproxy 12.2.3 noted available; version should be recorded at G0 and the addon written against that major | Added to G0: record version; addon uses only `request`/`response`/`load` (stable across majors) |
