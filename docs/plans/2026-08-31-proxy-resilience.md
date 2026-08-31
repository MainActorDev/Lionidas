# Proxy Resilience Implementation Plan — dead-man watchdog, all-service cleanup, bypass domains

> **For Hermes:** implement task-by-task with build/test verification between each. Human gate before Task 1.

**Goal:** the host's internet can never again depend on Crucible's process lifecycle — a wedged/killed proxy setup self-heals within ~30s (dev Mac boot, cloud Mac alike), and Apple/management traffic never enters the proxy.

**Context / verified defects (this session, live machine):**
- `main.ts:13-21` boot reconciliation reads `simRoutingState()` which resolves ONLY the default-route service (`primaryNetworkService()` throws when no default route exists — e.g. Wi-Fi not yet associated at boot). Result: reconciliation silently no-ops exactly when it's needed. **User's live symptom.**
- Cleanup on graceful close (`index.ts:130`) also uses `primaryNetworkService()` — if the default route moved (Wi-Fi ↔ Ethernet, VPN up/down) between enable and close, the WRONG service is cleared and the right one stays enabled. **Evidence: this machine has leftover disabled proxy configs on BOTH `Ethernet` (127.0.0.1:60793) and `Wi-Fi` (127.0.0.1:52310).**
- No mechanism survives `kill -9` / crash / power loss except the (broken) boot reconciliation.
- Cloud-Mac constraint (MacStadium, Ethernet-only, remote SSH/VNC access): SSH/VNC are raw TCP and never honor web proxies — they survive any proxy wedge. The real blast radius is CFNetwork clients (xcodebuild, softwareupdate, MDM check-ins). A self-healing watchdog bounds that to ~30s.

**Architecture (3 layers):**
1. **Correct in-process cleanup** — scan ALL network services, not the default-route one (Tasks 1, 3, 5).
2. **Independent dead-man watchdog** — launchd LaunchAgent shell script, runs every 15s OUTSIDE the Crucible process; kills any localhost proxy pointing at a dead listener (Tasks 2, 6). Survives `kill -9`, crash, power loss, and Crucible never being started at all.
3. **Blast-radius reduction** — proxy bypass domains for Apple/management/local traffic at enable time (Task 4).

**Tech:** TypeScript (tsx, vitest), `networksetup`/`lsof` shell-outs, launchd plist, no new dependencies.

**Verified integration points (live code, this session):**
- `server/src/forge/sim-routing.ts` — `primaryNetworkService():18-28` (default-route → service name, THROWS without route), `simRoutingState():37-52` (default-route only, swallows errors), `enableSimRouting():103-109`, `disableSimRouting():111-117`.
- `server/src/main.ts:13-21` — boot reconciliation block (uses `simRoutingState`).
- `server/src/index.ts:121-133` — `close()`: `stopMitmIfRunning()` then `disableSimRouting()`.
- `networksetup -listallnetworkservices` — prints header line then one service per line; stale/phantom services error individually on `-getwebproxy` (must be tolerated per-service: `** Error: Unable to find item in network database.` observed live).
- `lsof -nP -iTCP:<port> -sTCP:LISTEN` — exit 1 + empty when no listener (pattern already used in `main.ts:23-30`).
- Root `scripts/` holds user-run setup artifacts (`setup-forge-tls.command` precedent); `server/package.json` scripts: `dev/start/typecheck/lint/scan/check/test`.

**Constraint:** watchdog must be POSIX sh (no bash-isms) — launchd `ProgramArguments` runs `/bin/sh` directly.

**Safety constraint (user-mandated): ZERO writes to real network settings during implementation.** No `networksetup -set*` on any real service, no planted stale proxies, no live kill drills, no `launchctl load` without explicit approval. Verification protocol in place of live network mutation:
1. Unit tests drive the real TS logic through fake `networksetup`/`lsof` binaries on a temp PATH.
2. The watchdog script ships with `FORGE_WATCHDOG_DRY_RUN=1` (logs decisions, changes nothing) — run against the REAL machine to prove parsing/decisions on real output, zero side effects. Also useful on cloud Macs as a pre-activation audit.
3. The Task 6 drill runs end-to-end through the real script with fake binaries (simulated stale proxy in a temp PATH sandbox), not on real services.
4. Installer verified with `--no-load` + temp HOME (files land, plutil lints, nothing loaded).
5. Server restarts during dev only READ settings (`-getwebproxy`/`lsof`); heal fires only on a genuinely stale entry (machine currently clean — verified this session).
6. Deferred to explicit user go: `launchctl load` (activation) and the real heal drill (one-liner provided for self-service).

---

### Task 1: all-service stale-proxy scan (pure function, TDD)

**Objective:** one function that finds every network service with an enabled localhost web/secure-web proxy pointing at a dead listener.

**Files:**
- Modify: `server/src/forge/sim-routing.ts` (add `listNetworkServices`, `staleProxyServices`)
- Test: `server/test/sim-routing.test.ts` (create)

**Step 1: failing test.** `sh` is module-private; export it as `__shForTest` (test injects fake `networksetup`/`lsof` via PATH temp dir — keeps the real functions honest):

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { staleProxyServices } from '../src/forge/sim-routing.ts';

let binDir: string; const oldPath = process.env.PATH;
const services = ['Ethernet', 'Wi-Fi', 'USB'];

function fakeNetworksetup(services: string[], enabled: Record<string, { host: string; port: number } | undefined>): string {
  return `#!/bin/sh\n# $1 = -listallnetworkservices | -getwebproxy <svc>\ncase "$1" in\n  -listallnetworkservices) echo 'An asterisk (*) denotes that a network service is disabled.'; printf '%s\\n' ${services.map((s) => `'${s}'`).join(' ')}; exit 0;;  -getwebproxy) svc="$2"; exit 0;;  *) exit 1;; esac\n`;
}
// per-service output is dynamic; simplest robust fake: a directory of expected outputs keyed by svc name
function makeFakeBin(svcOut: (svc: string) => string): string {
  const dir = mkdtempSync(join(tmpdir(), 'nx-'));
  const f = join(dir, 'networksetup');
  writeFileSync(f, `#!/bin/sh\ncase "$1" in\n-listallnetworkservices) printf 'Ethernet\\nWi-Fi\\nUSB\\n';;-getwebproxy) cat "\${TMP_FAKE_DIR}/$2";;-setwebproxystate) exit 0;;esac\n`);
  chmodSync(f, 0o755);
  return dir;
}

beforeEach(() => { binDir = mkdtempSync(join(tmpdir(), 'crucible-test-')); process.env.PATH = `${binDir}:${oldPath}`; process.env.TMP_FAKE_DIR = binDir; });
afterEach(() => { rmSync(binDir, { recursive: true, force: true }); process.env.PATH = oldPath; });

function writeSvcOut(svc: string, enabled: boolean, host: string, port: number | string): void {
  writeFileSync(join(binDir, svc), `Enabled: ${enabled ? 'Yes' : 'No'}\nServer: ${host}\nPort: ${port}\nAuthenticated Proxy: 0\n`);
}

function fakeLsof(listening: number[]): void {
  const f = join(binDir, 'lsof');
  writeFileSync(f, `#!/bin/sh\n# args: -nP -iTCP:<port> -sTCP:LISTEN — last port arg wins\nport=""\nfor a in "$@"; do case "$a" in *TCP:*) port="${'${a#*:}'}";; esac; done\ncase " ${listening.join(' ')} " in *" $port "*) echo "COMMAND PID"; exit 0;; *) exit 1;; esac\n`);
  chmodSync(f, 0o755);
}

it('flags enabled localhost proxy with dead listener', () => {
  writeSvcOut('Wi-Fi', true, '127.0.0.1', 52310);
  writeSvcOut('Ethernet', false, '127.0.0.1', 60793);
  writeSvcOut('USB', true, 'corp-proxy.lan', 8080); // not localhost → untouched
  fakeLsof([]); // nothing listens anywhere
  expect(staleProxyServices()).toEqual([{ service: 'Wi-Fi', port: 52310 }]);
});

it('leaves enabled localhost proxies whose listener is alive', () => {
  writeSvcOut('Wi-Fi', true, '127.0.0.1', 52310);
  fakeLsof([52310]);
  expect(staleProxyServices()).toEqual([]);
});

it('tolerates per-service networksetup errors (phantom services)', () => {
  writeFileSync(join(binDir, 'USB'), '** Error: Unable to find item in network database.\n');
  writeSvcOut('Wi-Fi', true, '127.0.0.1', 9999);
  fakeLsof([]);
  expect(staleProxyServices()).toEqual([{ service: 'Wi-Fi', port: 9999 }]);
});
```

(Exact fake-shell quoting will be adjusted to what actually runs — the assertions are the contract.)

**Step 2:** FAIL (functions missing).

**Step 3: implement** in `sim-routing.ts`:

```ts
/** All configured network service names (header line skipped). Phantom
 *  services are listed but error on -getwebproxy — callers tolerate. */
export function listNetworkServices(): string[] {
  const out = sh('networksetup', ['-listallnetworkservices']);
  return out.split('\n').slice(1).map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith('*'));
}

export interface StaleProxy { service: string; port: number }

/** Every service whose ENABLED web proxy points at localhost with no live
 *  listener — i.e. internet-breaking leftovers from a dead Crucible (or any
 *  other proxy tool). Survives default-route absence (boot-time Wi-Fi). */
export function staleProxyServices(): StaleProxy[] {
  const stale: StaleProxy[] = [];
  for (const service of listNetworkServices()) {
    try {
      const out = sh('networksetup', ['-getwebproxy', service]);
      const enabled = /^Enabled: Yes$/m.test(out);
      const host = /Server: (\S+)/.exec(out)?.[1];
      const port = Number(/Port: (\d+)/.exec(out)?.[1] ?? 0);
      if (enabled && (host === '127.0.0.1' || host === 'localhost') && port > 0 && !portHasListener(port)) {
        stale.push({ service, port });
      }
    } catch { /* phantom service — skip */ }
  }
  return stale;
}

function portHasListener(port: number): boolean {
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.trim().length > 0;
  } catch { return false; }
}
```

Note: `portHasListener` currently lives in `main.ts` — move it here (Task 3 deletes the copy). `execFileSync` already imported.

**Step 4:** `pnpm vitest run test/sim-routing.test.ts` → PASS. **Step 5:** `pnpm typecheck` clean. Commit: `forge: all-service stale-proxy scan (the boot-brick detector)`.

---

### Task 2: launchd dead-man watchdog (script + plist + installer)

**Objective:** a 15s-interval LaunchAgent, fully independent of Crucible, that disables any enabled localhost proxy with a dead listener. Survives crash/kill/power-loss; works even if Crucible is never installed/started again.

**Files:**
- Create: `scripts/forge-watchdog.sh` (repo root `scripts/`, beside `setup-forge-tls.command`)
- Create: `scripts/com.crucible.forge-watchdog.plist`
- Create: `server/scripts/install-watchdog.ts`

**`scripts/forge-watchdog.sh`** — POSIX sh, idempotent, silent when healthy:

```sh
#!/bin/sh
# Crucible forge watchdog — the dead-man switch.
# Every 15s (launchd KeepAlive+StartInterval): for every network service,
# if the web proxy is ENABLED, points at localhost, and NOTHING is listening
# on that port, disable it. A wedged/killed Crucible then costs at most one
# interval of broken CFNetwork traffic; SSH/VNC are never affected (raw TCP).
# Never touches non-localhost proxies (corp proxies stay alone).
set -u

LOG_TAG="crucible-forge-watchdog"
log() { logger -t "$LOG_TAG" "$1" 2>/dev/null || printf '%s %s\n' "$LOG_TAG" "$1" >> /tmp/forge-watchdog.log; }

networksetup -listallnetworkservices 2>/dev/null | tail -n +2 | while IFS= read -r raw_svc; do
  svc=$(printf '%s' "$raw_svc" | sed 's/^\*//')
  [ -n "$svc" ] || continue
  out=$(networksetup -getwebproxy "$svc" 2>/dev/null) || continue
  enabled=$(printf '%s\n' "$out" | sed -n 's/^Enabled: \(.*\)$/\1/p')
  host=$(printf '%s\n' "$out" | sed -n 's/^Server: \(.*\)$/\1/p')
  port=$(printf '%s\n' "$out" | sed -n 's/^Port: \(.*\)$/\1/p')
  [ "$enabled" = "Yes" ] || continue
  case "$host" in 127.0.0.1|localhost|::1) ;; *) continue ;; esac
  case "$port" in ''|*[!0-9]*) continue ;; esac
  if ! lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    networksetup -setwebproxystate "$svc" off >/dev/null 2>&1 || true
    networksetup -setsecurewebproxystate "$svc" off >/dev/null 2>&1 || true
    log "disabled stale web proxy on '$svc' (127.0.0.1:$port had no listener)"
  fi
done
```

**`scripts/com.crucible.forge-watchdog.plist`** — runs at load + every 15s, restarts on failure, no docs UI:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.crucible.forge-watchdog</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>CRUCIBLE_WATCHDOG_SCRIPT_PATH</string>
  </array>
  <key>StartInterval</key><integer>15</integer>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>StandardErrorPath</key><string>/tmp/forge-watchdog.err</string>
</dict>
</plist>
```

(`KeepAlive false` + `StartInterval`: interval job, not a daemon — launchd runs it every 15s regardless of prior exit.)

**`server/scripts/install-watchdog.ts`** — installer (run: `pnpm tsx scripts/install-watchdog.ts [--uninstall]`):

```ts
/** Install/uninstall the forge dead-man watchdog LaunchAgent.
 *  Copies scripts/forge-watchdog.sh to ~/.crucible/ (plist must reference a
 *  stable path — repo checkouts move), rewrites the placeholder, loads it. */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const repoRoot = join(import.meta.dirname, '..', '..');           // crucible/
const srcSh = join(repoRoot, 'scripts', 'forge-watchdog.sh');
const srcPlist = join(repoRoot, 'scripts', 'com.crucible.forge-watchdog.plist');
const destDir = join(homedir(), '.crucible');
const destSh = join(destDir, 'forge-watchdog.sh');
const destPlist = join(homedir(), 'Library', 'LaunchAgents', 'com.crucible.forge-watchdog.plist');
const label = 'com.crucible.forge-watchdog';

const uninstall = process.argv.includes('--uninstall');
if (uninstall) {
  try { execFileSync('launchctl', ['unload', '-w', destPlist]); } catch { /* not loaded */ }
  for (const f of [destPlist, destSh]) if (existsSync(f)) rmSync(f);
  console.log('watchdog uninstalled');
} else {
  mkdirSync(destDir, { recursive: true });
  copyFileSync(srcSh, destSh);
  execFileSync('chmod', ['755', destSh]);
  writeFileSync(destPlist, readFileSync(srcPlist, 'utf8').replace('CRUCIBLE_WATCHDOG_SCRIPT_PATH', destSh));
  execFileSync('plutil', ['-lint', destPlist]);                    // validate before load
  execFileSync('launchctl', ['unload', '-w', destPlist], { stdio: 'ignore' }); // reload idempotency
  execFileSync('launchctl', ['load', '-w', destPlist]);
  console.log(`watchdog installed: ${destPlist} (script ${destSh})`);
}
```

**Verify (manual, Task 6 automates):** `sh -n scripts/forge-watchdog.sh` syntax OK; `pnpm tsx scripts/install-watchdog.ts` → `launchctl list | grep crucible` shows the label.

**Step:** commit `watchdog: launchd dead-man switch for stale localhost proxies`.

---

### Task 3: boot reconciliation + close() over ALL services

**Objective:** fix both in-process cleanup paths to use the all-service scan; retry at boot while Wi-Fi associates.

**Files:**
- Modify: `server/src/main.ts` (reconciliation block)
- Modify: `server/src/index.ts` (`close()`)

**main.ts** — replace the block at lines 13-21:

```ts
// BOOT RECONCILIATION: a previous instance may have died without clearing
// the OS proxy (kill -9, crash, power loss). The old check read only the
// DEFAULT-ROUTE service — at boot Wi-Fi may not have associated yet, so the
// scan silently no-oped exactly when it mattered. Scan ALL services, and
// retry briefly: stale entries can appear late as interfaces come up.
{
  const heal = async (): Promise<number> => {
    const stale = staleProxyServices();
    for (const s of stale) {
      try {
        sh('networksetup', ['-setwebproxystate', s.service, 'off']);
        sh('networksetup', ['-setsecurewebproxystate', s.service, 'off']);
        app.app.log.warn({ service: s.service, port: s.port }, 'cleared stale localhost proxy — internet restored');
      } catch { /* leave to the watchdog */ }
    }
    return stale.length;
  };
  let n = await heal();
  // Retry ONLY while no default route exists (early boot — Wi-Fi still
  // associating, stale entries appear late). On a normal dev restart the
  // route exists immediately → zero retries → no startup delay.
  if (n === 0 && process.env.CRUCIBLE_SKIP_BOOT_HEAL_RETRY !== '1') {
    for (let i = 0; i < 10 && n === 0 && !defaultRouteExists(); i++) {
      await new Promise((r) => setTimeout(r, 3000));
      n = await heal();
    }
  }
}
```

Delete the now-duplicated `portHasListener` from main.ts (moved to sim-routing.ts in Task 1). Import `staleProxyServices` + `sh`-equivalent — `sh` is private; either export it or inline `execFileSync('networksetup', [...])` (prefer inline; keeps `sh` private).

**index.ts `close()`** — replace `disableSimRouting()` (line 130) with the same all-service heal (extracted to `healStaleProxies(): number` exported from sim-routing.ts, logging via return value):

```ts
try { const healed = healStaleProxies(); if (healed) app.log.warn({ services: healed }, 'cleared stale proxies on close'); } catch { /* watchdog will */ }
```

**Verify:** `pnpm typecheck && pnpm vitest run` green (98+3). Commit: `forge: boot/close heal ALL services (fixes default-route-only brick)`.

---

### Task 4: bypass domains at enable

**Objective:** while routing is ON, Apple/management/local traffic bypasses the proxy — cloud-Mac MDM/xcodebuild/softwareupdate keep working even mid-wedge.

**Files:** Modify `server/src/forge/sim-routing.ts` `enableSimRouting`:

```ts
const DEFAULT_BYPASS = ['localhost', '127.0.0.1', '::1', '*.local', '*.apple.com', '*.push.apple.com', 'macstadium.com', '*.macstadium.com'];

/** Point the host (and thus sims, after reboot) at the forge proxy. Bypass
 *  domains keep Apple/management/local traffic DIRECT even while routing is
 *  active — shrinks the blast radius of any wedge (cloud MDM must never
 *  transit a QA proxy). Override with FORGE_PROXY_BYPASS (comma-separated). */
export function enableSimRouting(port: number): RoutingState {
  const service = primaryNetworkService();
  const bypass = (process.env.FORGE_PROXY_BYPASS?.split(',').map((s) => s.trim()).filter(Boolean) ?? DEFAULT_BYPASS);
  sh('networksetup', ['-setwebproxy', service, '127.0.0.1', String(port)]);
  sh('networksetup', ['-setsecurewebproxy', service, '127.0.0.1', String(port)]);
  if (bypass.length > 0) {
    sh('networksetup', ['-setproxybypassdomains', service, ...bypass]);
  }
  return simRoutingState();
}
```

**Verify:** `pnpm typecheck`; live: `networksetup -getproxybypassdomains Wi-Fi` shows the list after an enable cycle. Commit: `forge: proxy bypass domains (Apple/MacStadium/local stay direct)`.

---

### Task 5: enable/disable route guard (API kill switch)

**Objective:** one-call remote recovery from the web UI (no SSH needed on a cloud Mac): `GET /api/forge/routing` already exists; ensure `POST /api/forge/routing` with `{enabled:false}` runs the all-service heal (it calls `disableSimRouting` — swap to heal), and returns what was healed.

**Files:** Modify `server/src/forge/routes.ts` (routing enable/disable handler).

**Verify:** `pnpm typecheck`; live: set a fake stale proxy, POST disable, confirm healed + internet OK. Commit: `forge: routing off = all-service heal (API kill switch)`.

---

### Task 6: live drill — prove the whole chain on this machine

**Objective:** end-to-end proof of the user's exact failure mode healing itself.

1. `pnpm tsx scripts/install-watchdog.ts` (Task 2) → `launchctl list | grep crucible` present.
2. Simulate the brick: `networksetup -setwebproxy Wi-Fi 127.0.0.1 59999; networksetup -setwebproxystate Wi-Fi on` (59999 = nothing listening) → `curl -m5 https://apple.com` FAILS (or bypass saves it — either way, condition present).
3. Wait ≤15s → `networksetup -getwebproxy Wi-Fi` shows `Enabled: No` → `curl` 200 OK. **This is the user's boot scenario healing itself.**
4. Crash drill: enable real routing via API (forge on) → `kill -9` the server → within 15s watchdog restores internet (verify + `scutil --proxy` all disabled).
5. Boot-path drill: `CRUCIBLE_SKIP_BOOT_HEAL_RETRY=1 pnpm dev` with a stale proxy planted → healed without retry loop.
6. Uninstall/reinstall watchdog once (idempotency): no errors, still loaded.
7. `tail /tmp/forge-watchdog.err` empty; `log show --last 5m --predicate 'sender == "crucible-forge-watchdog"'` shows the heal events (or /tmp/forge-watchdog.log fallback).

**Verify:** all six drills pass; screenshot-level evidence captured in run output. Commit (if fixes needed): `watchdog: drill fixes`.

---

### Task 7: docs + DEFERRED close-out

- DEFERRED.md: new section header note under B (or a new "D. Cloud deployment — routing resilience" section) recording: watchdog shipped, all-service heal shipped, bypass domains shipped, pf permanently rejected (eats SSH), app-level proxy (Option D) remains the end-state if host-proxy keeps fighting cloud quirks — trigger: first MacStadium staging run. B2 stays (run watchdog ≠ proxy watchdog).
- README/server README (wherever forge routing is documented): one paragraph — watchdog install command, what it does, 15s bound.
- Commit: `docs: proxy resilience shipped — watchdog, all-service heal, bypass`.

---

## Self-review (done at draft time — findings already folded in)

- [x] **POSIX sh**: watchdog uses `case`/`sed`/`while IFS read` — no bashisms (`local`, arrays, `[[ ]]` absent). launchd runs `/bin/sh` = bash-posix-mode on macOS; still written for dash-level sh.
- [x] **Phantom services tolerated** both in TS (per-service try/catch) and sh (`|| continue`).
- [x] **No default-route dependency** anywhere in the heal path — the original bug.
- [x] **`-setproxybypassdomains` REPLACES the list** (macOS semantics) — documented; env override for site-specific additions. Wi-Fi's current leftover ports are untouched config, not bypass entries — no interaction.
- [x] **Watchdog never touches non-localhost proxies** (corp proxies survive) — guarded by `case "$host"`.
- [x] **launchd user agent, not daemon** — no root, no admin prompt; runs for the console user; works over SSH for the same user.
- [x] **Stable script path** (`~/.crucible/`) — repo checkouts move; plist references the copy.
- [x] **Watchdog cannot fight a healthy Crucible**: when Crucible's mitm IS listening, `lsof` finds the listener → no action. Race window (mitm starting, proxy just set): watchdog fires between `setwebproxy` and mitm listen → Crucible's own state shows enabled-but-cleared; next forge enable re-sets. Mitigation note: forge start sequence already starts mitm BEFORE enabling routing (manager start → routing enable); verified order in `forge/routes.ts` start handler. Worst case is a retry, not a brick.
- [x] **Tests cover** the three behaviors: stale-flag, alive-listener-untouched, non-localhost-untouched, phantom-tolerated.
- [x] `import.meta.dirname` — Node ≥ 20.11 (repo runs Node 24 via nvm). ✔
- [x] Boot retry capped (30s) + `CRUCIBLE_SKIP_BOOT_HEAL_RETRY` escape hatch so dev restarts don't hang when offline on purpose.

## Risks / open questions

- **Watchdog vs. fast forge restarts:** 15s window where a just-set proxy with mitm still binding could be cleared. Order guarantee (mitm first) makes this a non-issue in practice; if it ever bites, widen to "listener OR crucible-server-port alive" check.
- **MDM profiles** could pin proxy settings — then `networksetup` writes fail loudly; watchdog logs and retries, no infinite loop (it acts only on dead-listener entries).
- **`logger` vs file fallback** — belt and braces for headless SSH sessions where syslog routing differs.
- B2 (run-level watchdog/abort) intentionally NOT covered here — different failure domain, stays deferred.

**Human gate: approve below before Task 1 starts.**
