# App Install Pre-check + Explicit Install (1+3) Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Playing a test case on a sim missing the target app must fail fast with an actionable error + one-click install; the device panel gains an explicit artifact picker + install button.

**Architecture:** A new `app_catalog` table stores the last-known installable artifact per bundle id. The play path pre-checks installed apps BEFORE the run row exists and throws a typed `APP_NOT_INSTALLED` error carrying the last-known artifact. A new install route runs `simctl install` directly (no engine) under a per-device in-flight guard and records into `app_catalog`. **Artifacts live in a Crucible-OWNED store (`<data-root>/apps/`, alongside the DB like B6's preset-bodies): choosing an artifact from a scan CLONES it into the store (APFS `clonefile` — near-instant, no extra blocks while source lives; plain-copy fallback cross-volume); installs and the catalog reference ONLY store paths, never repo/DerivedData paths, so repo cleans/branch churn can never rot them.** Web: play error renders an install hint-bar (install → auto-replay once); DeviceSidebar gains an install card with artifact picker.

**Tech Stack:** Fastify + better-sqlite3 (server), Vue 3 SFC + shared CSS primitives (web), `xcrun simctl` via `execFile`.

**Settled decisions (do not re-litigate):**
- EXPLICIT install only — no silent auto-install on play (stale binary poisons verdicts; user decision 2026-09-04).
- Scope = option 1 (pre-check + actionable error) + option 3 (install button in device panel). Option 2 (auto-install) rejected.
- Auto-replay ONCE after a successful install from the hint is in scope ("one-click remediation").

---

## Current state (verified in code, 2026-09-04)

- Play: `POST /api/templates/:id/play` (`routes/manual.ts:181`) → `runTemplatePlayback()` (`manual/playback.ts:186`). Device resolution `resolveUdid()` (playback.ts:193): explicit > recorded-if-booted > single-booted > recorded.
- Playback NEVER installs. App open runs inside the background `done` promise → missing app aborts ~17s in: `open failed: alloy_apps: Simulator device failed to launch <bundle>`, zero steps (verified live on the bare 16 Plus).
- `listSimulatorApps(udid)` (`manual/apps.ts:32`) exists, imported by routes/manual.ts:8. Shells `simctl listapps` — **405 when the sim is shutdown**. Runs ~300ms booted.
- `app_version` already stamped best-effort at run creation (playback.ts:~220) via dynamic `await import('./apps.ts')`.
- `PlaybackError` has only `DEVICE_BUSY` (playback.ts:106). Mapped: single play → 409; `runBatch` → `{ok:false, code:409}`.
- `runs.artifact_path` only written by the queued alloy-runner; DB has ZERO `.app` rows (all 154 runs manual, artifact = screenshot PNG). → last-known artifact needs NEW storage.
- `migrateM1(db)` (`db/schema.ts:4`) is the guarded-ALTER migration every test harness uses.
- Engine `alloy_apps install` returns `{ok:true, data:{appName…}}` — NO version field. (Direct `simctl install` for our route; version via `readBundleIdentity` on the artifact.)
- Test harnesses: `app.inject` pattern exists (`forge.editor.test.ts`); playback harness with `__setAlloyForTest` + in-memory `migrateM1` db.
- Facts measured live: `simctl install` of 859MB LP Dev ≈ 12s. Artifacts at `ios-consumer/build/{record,verify}-*/Build/Products/Dev -iphonesimulator/LionParcelLogistics.app` + DerivedData `*/Build/Products/{Dev ,Debug}-iphonesimulator/*.app`.

---

## Task 1: `app_catalog` table + store helpers

**Objective:** Persist last-known artifact per bundle id.

**Files:**
- Modify: `server/src/db/schema.ts` — `app_catalog` is a NEW TABLE, so it goes in the `db.exec` CREATE TABLE block (append-only DDL contract, alongside `plans`), **NOT** the guarded-ALTER list (that list is column-adds only)
- Create: `server/src/manual/app-catalog-store.ts`
- Test: `server/test/app-catalog.test.ts`

**Step 1 — failing test:**

```ts
// server/test/app-catalog.test.ts
import { describe, it, expect } from 'vitest';
import { Database } from 'better-sqlite3';
import { migrateM1 } from '../src/db/schema.ts';
import { lastArtifactFor, recordArtifact } from '../src/manual/app-catalog-store.ts';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  migrateM1(db);
  return db;
}

describe('app-catalog store', () => {
  it('returns null when nothing recorded', () => {
    const db = freshDb();
    expect(lastArtifactFor(db, 'com.lioparcel.services.consumer-dev')).toBeNull();
  });

  it('round-trips artifact, version, recordedAt (latest wins)', () => {
    const db = freshDb();
    recordArtifact(db, { bundleId: 'b', artifactPath: '/old.app', appVersion: '1.0.0' });
    recordArtifact(db, { bundleId: 'b', artifactPath: '/new.app', appVersion: '3.4.0' });
    const a = lastArtifactFor(db, 'b')!;
    expect(a.artifactPath).toBe('/new.app');
    expect(a.appVersion).toBe('3.4.0');
    expect(a.recordedAt).toBeGreaterThan(0);
  });
});
```

**Step 2 — verify failure:** `cd ai/crucible/server && npx vitest run test/app-catalog.test.ts` → FAIL (module missing).

**Step 3 — implement:**

```ts
// server/src/manual/app-catalog-store.ts
/** Last-known installable artifact per bundle id — provenance for the
 *  install feature. Writers: install route, queued-runner path. Reader:
 *  APP_NOT_INSTALLED payload + sidebar install section. */
import type Database from 'better-sqlite3';

export interface LastArtifact {
  bundleId: string; artifactPath: string; artifactSha: string | null;
  appVersion: string | null; recordedAt: number;
}

export function lastArtifactFor(db: Database.Database, bundleId: string): LastArtifact | null {
  const row = db.prepare('SELECT bundle_id, artifact_path, artifact_sha, app_version, recorded_at FROM app_catalog WHERE bundle_id = ?').get(bundleId) as
    | { bundle_id: string; artifact_path: string; artifact_sha: string | null; app_version: string | null; recorded_at: number }
    | undefined;
  if (!row) return null;
  return { bundleId: row.bundle_id, artifactPath: row.artifact_path, artifactSha: row.artifact_sha,
           appVersion: row.app_version, recordedAt: row.recorded_at };
}

export function recordArtifact(db: Database.Database, entry: {
  bundleId: string; artifactPath: string; artifactSha?: string | null; appVersion?: string | null;
}): void {
  db.prepare(
    `INSERT INTO app_catalog(bundle_id, artifact_path, artifact_sha, app_version, recorded_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(bundle_id) DO UPDATE SET
       artifact_path = excluded.artifact_path,
       artifact_sha  = excluded.artifact_sha,
       app_version   = excluded.app_version,
       recorded_at   = excluded.recorded_at`,
  ).run(entry.bundleId, entry.artifactPath, entry.artifactSha ?? null, entry.appVersion ?? null, Date.now());
}
```

Schema addition (NEW TABLE → goes in the `db.exec` CREATE TABLE block, not the ALTER list):

```sql
CREATE TABLE IF NOT EXISTS app_catalog(
  bundle_id TEXT PRIMARY KEY,
  artifact_path TEXT NOT NULL,
  artifact_sha TEXT,
  app_version TEXT,
  recorded_at INTEGER NOT NULL
);
```

**Step 4 — verify pass:** same command → 2 passed.
**Step 5 — commit:** `feat(app-catalog): app_catalog table + last-known-artifact store`

---

## Task 2: `readBundleIdentity` export + artifact discovery + Crucible-owned store

**Objective:** Read bundle id/version from a `.app` dir; enumerate DISCOVERABLE artifacts (freshest first); provide `importArtifact()` which clones a chosen artifact into the Crucible-owned store.

**Ownership rule (user decision 2026-09-04): repo build dirs and DerivedData are DISCOVERY sources only — never install sources and never catalog sources.** A repo `git clean`, branch switch, or Xcode cache prune must not rot an installed or recorded artifact. The store lives at `<server data root>/apps/` (same convention as B6's `preset-bodies/`: `dirname(CRUCIBLE_DB_PATH)/apps`, env override `CRUCIBLE_APPS_DIR`).

**Files:**
- Modify: `server/src/manual/apps.ts` (export `readBundleIdentity`)
- Create: `server/src/manual/artifacts.ts` (discovery + store import)
- Test: `server/test/artifacts.test.ts`

**Step 1 — failing test:**

```ts
// server/test/artifacts.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findArtifacts } from '../src/manual/artifacts.ts';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'artifacts-test-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function plantApp(rel: string, bundleId: string, version: string, mtime: Date): string {
  const app = join(root, rel);
  mkdirSync(app, { recursive: true });
  // minimal plist — readBundleIdentity shells plutil, which handles real plists;
  // the helper must tolerate parse failure by returning null (skipped artifact)
  writeFileSync(join(app, 'Info.plist'), `<?xml version="1.0"?>\n<plist version="1.0"><dict>
    <key>CFBundleIdentifier</key><string>${bundleId}</string>
    <key>CFBundleShortVersionString</key><string>${version}</string>
  </dict></plist>`);
  utimesSync(join(app, 'Info.plist'), mtime, mtime);
  return app;
}

describe('findArtifacts', () => {
  it('finds build-dir and DerivedData layouts, newest first, skips unparsable', () => {
    const old = plantApp('build/record-1/Build/Products/Dev -iphonesimulator/AppOne.app', 'com.a.one', '1.0.0', new Date('2026-09-01'));
    const fresh = plantApp('DD/AbCd/Build/Products/Debug-iphonesimulator/AppTwo.app', 'com.a.two', '2.0.0', new Date('2026-09-03'));
    mkdirSync(join(root, 'build/broken/Build/Products/Dev -iphonesimulator/Broken.app'), { recursive: true }); // no Info.plist
    const found = findArtifacts([join(root, 'build')], [join(root, 'DD')]);
    expect(found.map((f) => f.bundleId)).toEqual(['com.a.two', 'com.a.one']);
    expect(found[0]!.path).toBe(fresh);
    expect(found[1]!.path).toBe(old);
  });

  it('returns [] for missing roots', () => {
    expect(findArtifacts([join(root, 'nope')], [join(root, 'nope2')])).toEqual([]);
  });
});
```

**Step 2 — verify failure:** `npx vitest run test/artifacts.test.ts` → FAIL.

**Step 3 — implement:**

```ts
// apps.ts — add export (refactor of private shortVersionFromBundle's plutil call)
export function readBundleIdentity(appPath: string): { bundleId: string; version: string | null } | null {
  try {
    const json = execFileSync('plutil', ['-convert', 'json', '-o', '-', join(appPath, 'Info.plist')],
      { maxBuffer: 1024 * 1024 }).toString();
    const p = JSON.parse(json) as { CFBundleIdentifier?: string; CFBundleShortVersionString?: string };
    if (!p.CFBundleIdentifier) return null;
    return { bundleId: p.CFBundleIdentifier, version: p.CFBundleShortVersionString ?? null };
  } catch { return null; }
}
```

```ts
// server/src/manual/artifacts.ts
/** Artifact discovery + the Crucible-owned store.
 *  Discovery (repo build outputs + DerivedData) is a PICKER data source
 *  ONLY — installing from a discovered path first IMPORTS (APFS clone)
 *  into the store; the catalog and simctl only ever see store paths.
 *  Store root: dirname(CRUCIBLE_DB_PATH)/apps (CRUCIBLE_APPS_DIR override). */
import { readdirSync, statSync, cpSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { readBundleIdentity } from './apps.ts';

export interface ArtifactInfo {
  path: string; bundleId: string; version: string | null;
  mtimeMs: number; source: 'build' | 'deriveddata' | 'store';
}

export function appsStoreDir(): string {
  return process.env['CRUCIBLE_APPS_DIR'] ?? join(dirname(process.env['CRUCIBLE_DB_PATH'] ?? './crucible.db'), 'apps');
}

/** Clone a discovered artifact into the store. `cpSync` with
 *  `verbatimSymlinks` uses clonefile(2) on APFS when possible —
 *  near-instant and no extra blocks while the source exists; falls back
 *  to a full copy cross-volume. Store name: <bundleId>-<version>-<mtime>.app
 *  (stable identity, no collision churn). Returns the STORE path. */
export function importArtifact(srcAppPath: string): string {
  const id = readBundleIdentity(srcAppPath);
  if (!id) throw new Error(`cannot read bundle identity from ${srcAppPath}`);
  const dest = join(appsStoreDir(), `${id.bundleId}-${id.version ?? 'unknown'}-${Math.round(statSync(srcAppPath).mtimeMs)}.app`);
  if (!existsSync(dest)) {
    mkdirSync(appsStoreDir(), { recursive: true });
    cpSync(srcAppPath, dest, { recursive: true, verbatimSymlinks: true });
  }
  return dest;
}

export function listStoreArtifacts(): ArtifactInfo[] { /* scan appsStoreDir(): *.app → identity + mtime, source: 'store' */ }

export function findArtifacts(
  buildRoots: string[] = [process.env['CRUCIBLE_LP_BUILD_ROOT'] ?? '/Volumes/berkakyo/Users/berkamain/Developer/w0rk/lionparcel/ios-consumer/build'],
  derivedRoots: string[] = [process.env['CRUCIBLE_DERIVED_ROOT'] ?? `${process.env.HOME ?? ''}/Library/Developer/Xcode/DerivedData`],
): ArtifactInfo[] {
  const out: ArtifactInfo[] = [
    ...scan(buildRoots, 'build'),
    ...scan(derivedRoots, 'deriveddata'),
    ...listStoreArtifacts(),
  ];
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function scan(roots: string[], source: ArtifactInfo['source']): ArtifactInfo[] {
  const found: ArtifactInfo[] = [];
  for (const root of roots) {
    let l1: string[];
    try { l1 = readdirSync(root); } catch { continue; }
    for (const a of l1) {
      // level 2: <root>/<proj>/Build/Products/<cfg>-iphonesimulator/*.app
      const products = join(root, a, 'Build', 'Products');
      let cfgs: string[];
      try { cfgs = readdirSync(products); } catch { continue; }
      for (const cfg of cfgs) {
        if (!cfg.endsWith('-iphonesimulator')) continue;
        const dir = join(products, cfg);
        let apps: string[];
        try { apps = readdirSync(dir); } catch { continue; }
        for (const app of apps) {
          if (!app.endsWith('.app')) continue;
          const full = join(dir, app);
          try {
            if (!statSync(full).isDirectory()) continue;
            const id = readBundleIdentity(full);
            if (!id) continue; // partial build output — skip
            found.push({ path: full, bundleId: id.bundleId, version: id.version,
                         mtimeMs: statSync(full).mtimeMs, source });
          } catch { continue; }
        }
      }
    }
  }
  return found;
}
```

(Find `findArtifacts`'s body above deliberately elided in one line — implement it as `return [...scan(buildRoots, 'build'), ...scan(derivedRoots, 'deriveddata'), ...listStoreArtifacts()].sort(...)`; store entries listed LAST in priority so fresh builds surface first, but they're the only SAFE sources. The picker UI (Tasks 6/7) labels each row's source.)

**Step 4 — verify pass.**
**Step 5 — commit:** `feat(app-catalog): artifact discovery + shared readBundleIdentity`

---

## Task 3: `installApp()` — direct simctl, in-flight guard

**Objective:** One install per device; watchdog; record into `app_catalog`.

**Files:**
- Create: `server/src/manual/app-install.ts`
- Test: `server/test/app-install.test.ts`

Design decisions:
- **Direct `xcrun simctl install`, NOT `alloy_apps install`**: every engine dispatch re-opens the shared `alloy` session + writes a host-global device claim — the exact DEVICE_IN_USE deadlock class fixed today (74e0bf4). A QA convenience path must not buy that. `simctl install` needs no session.
- In-flight map keyed by udid; concurrent request → `INSTALL_IN_FLIGHT` without invoking simctl.
- Timeout 10min (12s real, ×50 headroom).
- On success: `readBundleIdentity(appPath)` → `recordArtifact(db, {bundleId, artifactPath, appVersion})`. `artifact_sha` stays null — content-hashing 859MB is provenance theater; path+version+mtime suffice.

**Step 1 — failing test** (fake `xcrun` on PATH, forge-watchdog pattern):

```ts
// server/test/app-install.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from 'better-sqlite3';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REAL_PATH = process.env.PATH!;

function fakeXcrun(dir: string, opts: { delayMs?: number; fail?: boolean }): string {
  const script = join(dir, 'xcrun');
  writeFileSync(script, [
    '#!/bin/sh',
    `echo "xcrun $@" >> ${JSON.stringify(join(dir, 'calls.log'))}`,
    opts.delayMs ? `sleep ${(opts.delayMs / 1000).toFixed(1)}` : '',
    opts.fail ? 'echo "install failed" >&2; exit 70' : '',
    'exit 0',
    '',
  ].join('\n'));
  chmodSync(script, 0o755);
  return dir;
}

function plantArtifact(root: string, bundleId: string, version: string): string {
  const app = join(root, `${bundleId.replace(/\./g, '_')}.app`);
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'Info.plist'),
    `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundleId}</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`);
  return app;
}

let root: string; let db: Database.Database; let bin: string;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'app-install-test-'));
  bin = mkdtempSync(join(tmpdir(), 'bin-'));
  const { migrateM1 } = await import('../src/db/schema.ts');
  db = new Database(':memory:'); migrateM1(db);
  process.env.PATH = `${bin}:${REAL_PATH}`;
});
afterEach(() => { process.env.PATH = REAL_PATH; rmSync(root, { recursive: true, force: true }); rmSync(bin, { recursive: true, force: true }); db.close(); });

describe('installApp', () => {
  it('installs, records into app_catalog, returns version + duration', async () => {
    fakeXcrun(bin, {});
    const app = plantArtifact(root, 'com.test.app', '3.4.0');
    const { installApp } = await import('../src/manual/app-install.ts');
    const r = await installApp({ db }, { udid: 'UDID-1', appPath: app });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.version).toBe('3.4.0'); expect(r.durationMs).toBeGreaterThanOrEqual(0); }
    const calls = readFileSync(join(bin, 'calls.log'), 'utf8');
    expect(calls).toContain('simctl install UDID-1');
    const { lastArtifactFor } = await import('../src/manual/app-catalog-store.ts');
    expect(lastArtifactFor(db, 'com.test.app')?.artifactPath).toBe(app);
  });

  it('INSTALL_IN_FLIGHT: second concurrent call does not invoke simctl again', async () => {
    fakeXcrun(bin, { delayMs: 300 });
    const app = plantArtifact(root, 'com.test.app', '1.0.0');
    const { installApp } = await import('../src/manual/app-install.ts');
    const p1 = installApp({ db }, { udid: 'UDID-1', appPath: app });
    const r2 = await installApp({ db }, { udid: 'UDID-1', appPath: app });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.code).toBe('INSTALL_IN_FLIGHT');
    await p1;
    const calls = readFileSync(join(bin, 'calls.log'), 'utf8');
    expect(calls.match(/simctl install/g)?.length).toBe(1);
  });

  it('INSTALL_FAILED surfaces exit code + stderr; ARTIFACT_UNREADABLE when identity missing', async () => {
    fakeXcrun(bin, { fail: true });
    const app = plantArtifact(root, 'com.test.app', '1.0.0');
    const { installApp } = await import('../src/manual/app-install.ts');
    const r = await installApp({ db }, { udid: 'UDID-1', appPath: app });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('INSTALL_FAILED');
    const broken = join(root, 'Broken.app'); mkdirSync(broken);
    const r2 = await installApp({ db }, { udid: 'UDID-1', appPath: broken });
    if (!r2.ok) expect(r2.code).toBe('ARTIFACT_UNREADABLE');
  });
});
```

**Step 2 — verify failure.** **Step 3 — implement:**

```ts
// server/src/manual/app-install.ts
/** Explicit app install: direct simctl (no engine session/claim — avoids the
 *  DEVICE_IN_USE class), per-device in-flight guard, watchdog, catalog record. */
import type Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readBundleIdentity } from './apps.ts';
import { recordArtifact } from './app-catalog-store.ts';

const execFileAsync = promisify(execFile);
const INSTALL_TIMEOUT_MS = 10 * 60_000;

export type InstallResult =
  | { ok: true; version: string | null; durationMs: number }
  | { ok: false; code: 'INSTALL_IN_FLIGHT' | 'INSTALL_FAILED' | 'ARTIFACT_UNREADABLE'; error: string };

const inFlight = new Map<string, Promise<InstallResult>>();

export function installApp(deps: { db: Database.Database }, req: { udid: string; appPath: string }): Promise<InstallResult> {
  const existing = inFlight.get(req.udid);
  if (existing) {
    return Promise.resolve({ ok: false, code: 'INSTALL_IN_FLIGHT', error: 'an install is already running on this device' });
  }
  const p = (async (): Promise<InstallResult> => {
    const identity = readBundleIdentity(req.appPath);
    if (!identity) return { ok: false, code: 'ARTIFACT_UNREADABLE', error: `cannot read bundle identity from ${req.appPath}` };
    const t0 = Date.now();
    try {
      await execFileAsync('xcrun', ['simctl', 'install', req.udid, req.appPath], { timeout: INSTALL_TIMEOUT_MS });
    } catch (err) {
      const e = err as { code?: string | number; stderr?: string; message?: string };
      return { ok: false, code: 'INSTALL_FAILED', error: `simctl install failed (${e.code ?? '?'}): ${e.stderr ?? e.message ?? 'unknown'}` };
    }
    recordArtifact(deps.db, { bundleId: identity.bundleId, artifactPath: req.appPath, appVersion: identity.version });
    return { ok: true, version: identity.version, durationMs: Date.now() - t0 };
  })();
  inFlight.set(req.udid, p);
  void p.finally(() => { inFlight.delete(req.udid); });
  return p;
}
```

**Step 4 — verify pass.** **Step 5 — commit:** `feat(app-catalog): installApp — direct simctl, per-device guard`

---

## Task 4: Playback pre-check — typed `APP_NOT_INSTALLED`

**Objective:** Fail the play BEFORE any run row exists; carry remediation payload.

**Files:**
- Modify: `server/src/manual/playback.ts`
- Test: `server/test/playback-app-check.test.ts`

**Step 1 — failing test** (playback harness: `__setAlloyForTest` fake, in-memory `migrateM1` db, `awaitStreamLive: null`):

Cases:
1. app missing + catalog empty → `APP_NOT_INSTALLED`, payload `{appBundleId, lastArtifact: null}`, **no run row** created.
2. app missing + catalog has artifact → payload.lastArtifact.path set.
3. app present → proceeds (fake alloy receives the open).
4. `listApps` throws (shutdown sim) → proceeds (engine gate handles it — no false block).
5. `appToLaunch === 'com.apple.Preferences'` (no binding) → no pre-check.
6. **The template `udid` must point at a BOOTED mirror row** (or none at all) — `resolveUdid` falls back to `tpl.udid ?? ''`; a nonexistent udid string like `'sim'` still resolves, so seed `udid: 'sim'` + a booted `devices` row `'sim'` to make the harness deterministic (existing tests use `'sim'`).

Mocking `listSimulatorApps`: add a **seam** — optional `deps.listApps?: (udid: string) => Promise<Array<{bundleId: string}>>` on `PlaybackDeps`; default resolves the real one. Tests inject a stub; prod unchanged. (Same pattern as `awaitStreamLive`.)

```ts
// core of the test
it('throws APP_NOT_INSTALLED with lastArtifact payload, no run row', async () => {
  const db = new Database(':memory:'); migrateM1(db);
  insertTemplate(db, { id: 'tpl_x', name: 'x', appBundleId: 'com.test.app', steps: [{idx:0, action:'tap', x:1, y:2}] });
  recordArtifact(db, { bundleId: 'com.test.app', artifactPath: '/tmp/a.app', appVersion: '2.0.0' });
  let err: unknown;
  await runTemplatePlayback(harness(db, { listApps: async () => [] }), 'tpl_x', {}).catch((e) => { err = e; });
  expect(err).toBeInstanceOf(PlaybackError);
  expect((err as PlaybackError).code).toBe('APP_NOT_INSTALLED');
  expect((err as PlaybackError).payload?.lastArtifact?.path).toBe('/tmp/a.app');
  expect(db.prepare('SELECT COUNT(*) c FROM runs').get()).toEqual({ c: 0 });
});
```

**Step 2 — verify failure.** **Step 3 — implement:**

```ts
// PlaybackError gains the code + payload
export class PlaybackError extends Error {
  constructor(
    public code: 'DEVICE_BUSY' | 'APP_NOT_INSTALLED',
    message: string,
    public payload?: { appBundleId?: string; lastArtifact?: { path: string; version: string | null; recordedAt: number } | null },
  ) { super(message); }
}

// PlaybackDeps gains:
  /** installed-apps seam for the pre-check (tests stub; default = real listSimulatorApps) */
  listApps?: (udid: string) => Promise<Array<{ bundleId: string }>>;

// inside runTemplatePlayback, AFTER the DEVICE_BUSY guard, BEFORE the runId/INSERT.
// NOTE: `appToLaunch` is currently computed at playback.ts:203 — MOVE that
// const above the pre-check (it's declared just after the busy guard today;
// the pre-check slots between them, so hoist or inline it — keep ONE declaration).
  const appToLaunch = opts.bundleId ?? t.app_bundle_id ?? 'com.apple.Preferences';
  if (appToLaunch !== 'com.apple.Preferences') {
    let installed: Array<{ bundleId: string }> = [];
    try { installed = await (deps.listApps ?? defaultListApps)(udid); } catch { /* shutdown sim: engine gate reports honestly */ }
    if (installed.length > 0 && !installed.some((a) => a.bundleId === appToLaunch)) {
      const last = lastArtifactFor(deps.db, appToLaunch);
      throw new PlaybackError(
        'APP_NOT_INSTALLED',
        `app not installed on this device: ${appToLaunch}`,
        { appBundleId: appToLaunch, lastArtifact: last ? { path: last.artifactPath, version: last.appVersion, recordedAt: last.recordedAt } : null },
      );
    }
  }
```

`defaultListApps` = thin wrapper over `listSimulatorApps` (static import now safe: apps.ts imports only node builtins — no cycle). The existing app-version stamp keeps its dynamic import (harmless).

Note the `installed.length > 0` guard: an EMPTY list on a booted sim is implausible (Settings etc. always present) — treat empty-as-throw-catch: if listapps failed we skip. An empty successful listing would also skip the block (defensive against odd sim states blocking everything).

**Step 4 — verify pass** (new file + full playback suite: abort/expect/tap-resolution).
**Step 5 — commit:** `feat(playback): APP_NOT_INSTALLED pre-check before run row`

---

## Task 5: Routes — install, artifacts, error mapping

**Files:**
- Modify: `server/src/routes/manual.ts`
- Test: `server/test/install-route.test.ts` (`app.inject` harness)

Routes:

```
POST /api/devices/:udid/install     {appPath}
  → 200 {ok:true, version, durationMs}
  → 409 {error, code:'INSTALL_IN_FLIGHT' | 'DEVICE_NOT_BOOTED'}
  → 422 {error} (appPath missing)
  → 400 {error} (artifact not on disk)
  → 502 {error, code:'INSTALL_FAILED' | 'ARTIFACT_UNREADABLE'}

GET /api/devices/:udid/artifacts
  → 200 {artifacts: ArtifactInfo[]}
```

Play route error mapping (single play + runBatch + plans):

```ts
if (err instanceof PlaybackError && err.code === 'APP_NOT_INSTALLED') {
  return reply.code(409).send({ error: err.message, code: err.code, appBundleId: err.payload?.appBundleId, lastArtifact: err.payload?.lastArtifact ?? null });
}
```

`runBatch`'s catch: same branch → `{ok:false, code:409, error: 'batch aborted at template …: app not installed', runIds}` (report what ran, like DEVICE_BUSY today).

Install route body: `{appPath, import?: boolean}` — the server reads identity from the artifact itself; client-supplied bundleId would be a second source of truth (rejected). **If `appPath` is NOT under `appsStoreDir()`, the route first IMPORTS it into the store (APFS clone) and installs from the store path** — the catalog never records a repo/DerivedData path:

```ts
  const storePath = appPath.startsWith(appsStoreDir())
    ? appPath
    : importArtifact(appPath);          // clone → <data-root>/apps/<bundle>-<ver>-<mtime>.app
  const r = await installApp({ db }, { udid, appPath: storePath });
```

(The web UI never sets `import` — it just sends the picker's path; the route's own path check is the enforcement. `importArtifact` on a store path is idempotent by name, so the branch is belt-and-braces.)

**Edge-case 4 addition (from self-review): the install route ALSO rejects when a run/manual session holds the device** — installing mid-run mutates the device under test:

```ts
  const busy = db.prepare(`SELECT 1 FROM runs WHERE device_udid = ? AND status IN ('queued','running') LIMIT 1`).get(udid)
    ?? db.prepare(`SELECT 1 FROM manual_sessions WHERE udid = ? AND finished_at IS NULL LIMIT 1`).get(udid);
  if (busy) return reply.code(409).send({ error: 'a run or manual session is active on this device — wait or abort it', code: 'DEVICE_BUSY' });
```

(Column names verified against schema.ts:174-183 — `manual_sessions(udid, finished_at)` exist; `.hint-bar` exists in `web/src/styles/components.css`.)

**Test:** missing appPath → 422; nonexistent path → 400; shutdown device → 409 DEVICE_NOT_BOOTED (state from the `devices` mirror); happy path with fake xcrun → 200 + catalog row; in-flight → 409.

**Commit:** `feat(routes): install + artifact listing; APP_NOT_INSTALLED mapping`

---

## Task 6: Web — play error hint + one-click remediation

**Files:**
- Modify: `web/src/pages/TestCasesPage.vue`

In `play(t)`: branch on `code === 'APP_NOT_INSTALLED'`:

```ts
const b = (await r.json()) as { runId?: string; udid?: string; error?: string; code?: string;
  appBundleId?: string; lastArtifact?: { path: string; version: string | null; recordedAt: number } | null };
if (b.runId) { /* unchanged */ }
else if (b.code === 'APP_NOT_INSTALLED') {
  installHint.value = { templateId: t.id, appBundleId: b.appBundleId ?? t.appBundleId ?? '', lastArtifact: b.lastArtifact ?? null };
  playMsg.value = 'app not installed on this device';
}
else { playMsg.value = b.error ?? 'failed'; }
```

UI — a `.hint-bar` under the toolbar (shared primitive, no new dialect):

```
! app com.lioparcel… is not installed on this device
  [ install v3.4.0 · from build/verify-CUST-4324 ]   [ choose artifact… ]   [ dismiss ]
```

- Primary button (only when `lastArtifact`): `POST /api/devices/{resolvedUdid}/install {appPath: lastArtifact.path}` — label shows version + basename(dirname(path)) so the user sees WHICH build. During install: `installing… (≈12s)` disabled state.
- On success: clear hint, **auto-replay the same template once** (`play(t)` again). Exactly once — the retry goes through the same pre-check, so a still-missing app re-errors honestly rather than looping.
- `choose artifact…` opens a small modal: `GET /api/devices/{udid}/artifacts` → list (version · source label — `build:` / `deriveddata:` / `store:` · relative age), pick → install (route imports into store if needed) → auto-replay.
- The hint needs the RESOLVED udid — `play()` already receives it in the response (`b.udid`, added commit 3e0cac3). Store it in `installHint`.
- Dismiss clears state. Playing a different template replaces the hint.

**Verification (live drill, user geometry 1920×1080):** bare 16 Plus + tnc → run → hint with install button → install → auto-replay → steps execute. Screenshot + vision review. Fresh navigation before declaring done (HMR poison check).

**Commit:** `feat(web): install hint + one-click remediation on APP_NOT_INSTALLED`

---

## Task 7: Web — DeviceSidebar install card

**Files:**
- Modify: `web/src/components/DeviceSidebar.vue`

Below the app `<select>` card (visible when `booted`, i.e. the same gate as "acquire & take control"):

```
install app
  [ artifact picker: v3.4.0 · verify-CUST-4324 · 2h ago ▾ ]
  [ install ]        ← busy: "installing…", then refresh installed list
```

- Loads `GET /api/devices/:udid/artifacts` lazily on first open (picker is a `<select>` like the app one — shared style, no new dialect).
- Filter: default to artifacts whose `bundleId` matches the currently selected app in the control card when one is selected; show all otherwise (label the groups or prefix non-matching with their bundle id).
- Install → same route → on success refresh `/apps` list (the picker above re-renders with the new app).
- Errors render inline in the card (`--color-ember`), never a toast.

**Verification:** Playwright drill on booted sim: picker lists artifacts → install → installed list shows app. Screenshot + vision.

**Commit:** `feat(web): device sidebar install card`

---

## Task 8: Queued-runner records artifacts

**Files:**
- Modify: `server/src/alloy/runner.ts` (one line after successful `alloy_apps install`)

```ts
try {
  // provenance — record the STORE path, not the caller's repo/DerivedData path
  const storePath = spec.artifactPath.startsWith(appsStoreDir()) ? spec.artifactPath : importArtifact(spec.artifactPath);
  recordArtifact(deps.db, { bundleId: spec.app, artifactPath: storePath });
} catch { /* provenance best-effort */ }
```

Version: engine install returns no version (verified) → leave null; `lastArtifactFor` consumers tolerate null. Guarded try/catch — provenance must never fail a run.

**Test:** extend `alloy.runner.test.ts` (exists) — after a successful queued run, `lastArtifactFor(db, app)` is set.

**Commit:** `feat(runner): record installed artifact into app_catalog`

---

## Task 9: Guide + DEFERRED + skill close-out

- **GuidePage** "test cases" section: paragraph on the pre-check, the hint, the sidebar install, last-known artifact concept, and the env-overridable roots. Same-batch rule — ships with Task 6/7's commit if possible, else its own.
- **DEFERRED.md**: check for a missing-app entry — if present, move to built with a dated note; if absent, nothing (the design lives in the skill).
- **crucible SKILL.md**: the missing-app bullet's "NOT yet built" clause → shipped design + commit range. Also drop the now-stale `references/` pointer if none was written.

---

## Verification gates (every task, before its commit)

```bash
# server (Node v24! PATH prefix ~/.nvm/versions/node/v24.12.0/bin)
cd ai/crucible/server && pnpm typecheck && pnpm lint && npx vitest run
# web
cd ai/crucible/web && npx vue-tsc --noEmit && npx vite build
```

⛔ Never gate a commit on a piped verify — read the gate's OWN exit code (skill rule).

## Edge cases analyzed

| # | Case | Behavior |
|---|---|---|
| 1 | Sim shutdown at play time | `resolveUdid` may return a shutdown recorded device → `listApps` throws → pre-check skipped → engine stream gate aborts honestly (today's behavior). No false block. |
| 2 | Empty installed list (odd sim state) | `installed.length > 0` guard → pre-check skipped, engine gate decides. Prevents a broken listapps from blocking every run. |
| 3 | Template with NO app binding (`Preferences`) | Pre-check skipped entirely — Settings is always present. |
| 4 | Install raced with a run start | Install POST while a run holds the device: install proceeds (simctl is safe alongside) — but consider: if a run is ACTIVE on the device, installing mid-run mutates the device under test. **Decision: the install route also rejects with 409 DEVICE_BUSY-style `code:'RUN_ACTIVE'` when a queued/running run or manual session holds the device.** (Added to Task 5.) |
| 5 | Same artifact installed twice | Idempotent at simctl level; `recordArtifact` upserts; in-flight guard prevents double-run. |
| 6 | Artifact deleted from disk after recording | Route checks `existsSync` → 400 `artifact not found`; hint's install button errors → user picks another via `choose artifact…`. |
| 7 | Two installs, two devices | In-flight map is per-udid — both proceed in parallel. |
| 8 | Play-all / plan hits missing app on case 3 of 5 | runBatch aborts the REST at case 3 with `runIds` reported (mirrors DEVICE_BUSY semantics — consistent mental model). |
| 9 | Cross-bundle artifacts in picker | Picker shows bundleId for non-matching artifacts; no filtering lies. |
| 10 | `installed.length > 0` but app genuinely mid-install elsewhere | In-flight guard is install-route-side only; a simctl-level collision surfaces as INSTALL_FAILED with stderr. Honest. |
| 11 | Auto-replay loops? | No: replay goes through the same pre-check; success proceeds, still-missing re-errors once (no recursion beyond depth 1 — `installHint` cleared before replay). |
| 12 | Big DerivedData with stale `.app` dirs | `readBundleIdentity` returns null on unparsable → skipped; newest-first ordering puts fresh first. |
| 13 | `simctl install` >10min | Watchdog kills (execFile timeout) → INSTALL_FAILED with timeout note. |
| 14 | User's other Mac / different checkout | Roots env-overridable; guide documents. |
| 15 | Repo `git clean` / branch switch wipes the build-dir artifact AFTER it was imported | Catalog points at the STORE copy — unaffected. The repo copy only mattered at import time. |
| 16 | Xcode prunes DerivedData | Same as 15 — store copy survives; future discovery just stops listing it. |
| 17 | Store grows unbounded (859MB per import) | APFS clones share blocks while the source lives, so an import of a fresh build is near-free; true copies only after source deletion. Mitigation (later, on demand): GC oldest store entries per bundle id beyond N=3. Not in scope now — disk is cheap, silent deletion is not. |
| 18 | Import while disk full | `cpSync` throws → route 502 `IMPORT_FAILED` with the fs error; nothing half-recorded (recordArtifact runs only after successful install). |
| 19 | Same bundle+version rebuilt (mtime differs) | Store name includes mtime → new entry, old entry remains (harmless; GC later). |
| 20 | APFS clone fallback cross-volume (`/Volumes` home vs store on root volume) | `cpSync` degrades to full copy — slow (~seconds for 859MB) but correct; busy state in the UI covers it. |

## Risks / tradeoffs

- **+300ms on every play** (listapps) — accepted for fail-fast; 5s-per-udid cache possible later (YAGNI now).
- **Direct simctl bypasses the engine's freshness gate** (`assertFreshArtifact` vs srcPath) — intentional: explicit install IS the user's freshness decision; the hint shows version+build provenance so staleness is visible at click time.
- **`app_catalog` can go stale** (store artifact deleted manually) — route 400s honestly; picker offers live discovery.
- **Store costs disk** (~859MB per distinct build) — APFS clones make imports of live builds near-free; a later GC can cap per-bundle history. Deferred deliberately.

## Plain-English summary

Test cases need the app on the simulator. Today a missing app wastes ~17s and dies with a confusing engine message. After this plan: the run refuses to start with a clear "app not installed" message plus a button that installs the app from the last artifact we know of (or a picker of every build found on disk) and then runs the test automatically. The device panel gets the same install power on its own.

Artifacts you pick are first COPIED into Crucible's own storage (an instant APFS clone on your Mac), so installs never depend on some repo folder or Xcode cache being cleaned up later — the repo is only a place we *find* builds, never a place we *depend on*.
