/** B4b: the single owner of the addon state file (`forge-mitm-state.json`).
 *
 *  Before this module, SEVEN call sites wrote the file directly in three
 *  shapes; preset CRUD during a scenario-backed run rewrote it from DB
 *  presets and silently dropped the scenario override (and any attribution).
 *  Every write now COMPOSES the full truth — mode + (scenario override ??
 *  DB presets) + activeRunId — through one promise chain, so writers
 *  interleave in submission order and never clobber each other.
 *
 *  The env default ('/tmp/forge-mitm') is resolved ONCE here; the seven
 *  duplicated literals at call sites collapse into this module. */
import type Database from 'better-sqlite3';
import { mkdirSync, copyFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { presetRowToSpec, type Preset } from './matcher.ts';
import { writeStateFile } from './mitm/manager.ts';

export interface ForgeStateShape {
  mode: string;
  presets: unknown[];
  activeRunId: string | null;
}

export interface ForgeStateDeps {
  db: Database.Database;
  forgeState: ForgeStateShape;
}

export interface ForgeStateService {
  readonly stateDir: string;
  /** B6: frozen bodies live here — under the server data dir (DB path's
   * root), NOT /tmp which macOS purges. */
  readonly bodiesDir: string;
  /** DB presets → file (dashboard CRUD sync). Honors an active override. */
  sync(): void;
  /** Set the scenario override (from DB ROWS — mapped here through
   * presetRowToSpec) and update BOTH consumers: the addon state file
   * (compose) AND the in-process proxy's serving set
   * (deps.forgeState.presets). M3 self-review catch: compose() writes the
   * FILE only; the in-process proxy reads forgeState.presets, which nothing
   * else updated — scenario runs served DB presets on that path. */
  activateScenario(presetRows: Array<Record<string, unknown>>): void;
  /** Clear the override (back to DB presets) — resets BOTH the file and the
   * in-process serving set, keeping the active run. */
  clearScenario(): void;
  /** Set/clear traffic attribution; composes with the current override. */
  setActiveRun(runId: string | null): void;
  /** Resolve once every queued write has landed (tests + callers needing
   * read-after-write certainty). */
  drain(): Promise<void>;
}

const stateServiceCache = new WeakMap<object, ForgeStateService>();

export function forgeStateService(deps: ForgeStateDeps): ForgeStateService {
  // memoized per deps identity — the playback test harness (and routes) pass
  // the same deps object per app instance; distinct harnesses get distinct
  // services with isolated override/chain state.
  const cached = stateServiceCache.get(deps.forgeState as unknown as object);
  if (cached) return cached;

  const stateDir = process.env['CRUCIBLE_MITM_STATE_DIR'] ?? '/tmp/forge-mitm';
  // B6: bodies under the data root (wherever the DB lives — CRUCIBLE_DB_PATH's
  // dir, defaulting to cwd), overridable for tests.
  const bodiesDir = process.env['CRUCIBLE_MITM_BODIES_DIR'] ?? resolve(join(dirname(process.env['CRUCIBLE_DB_PATH'] ?? './crucible.db'), 'preset-bodies'));
  let override: Preset[] | null = null;

  // B6 migration: copy legacy /tmp bodies into bodiesDir (non-destructive),
  // rewrite presets.body_path rows that still point at the old dir.
  try {
    const legacyDir = join(stateDir, 'preset-bodies');
    if (existsSync(legacyDir) && legacyDir !== bodiesDir) {
      mkdirSync(bodiesDir, { recursive: true });
      for (const f of readdirSync(legacyDir)) {
        if (!f.endsWith('.body')) continue;
        const from = join(legacyDir, f);
        const to = join(bodiesDir, f);
        if (!existsSync(to)) copyFileSync(from, to);
        deps.db.prepare(`UPDATE presets SET body_path = ? WHERE body_path = ?`).run(to, from);
      }
    }
  } catch { /* migration best-effort */ }

  const dbPresets = (): Preset[] =>
    (deps.db.prepare('SELECT * FROM presets ORDER BY created_at DESC').all() as Array<Record<string, unknown>>).map(presetRowToSpec);

  const compose = (): void => {
    writeStateFile(stateDir, deps.forgeState.mode, override ?? dbPresets(), deps.forgeState.activeRunId);
  };

  // serialization: a module-level chain shared by THIS service instance —
  // sync/activate/setActiveRun interleave in submission order, never clobber.
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (op: () => void): void => {
    chain = chain.then(() => {
      try { op(); } catch { /* best-effort — addon keeps last-good state */ }
    });
  };

  const svc: ForgeStateService = {
    stateDir,
    bodiesDir,
    sync: () => enqueue(compose),
    // ONE owner of scenario activation: map rows → spec HERE (B8) and update
    // BOTH proxy consumers — the state file (compose) and the in-process
    // serving set. Previously the route + playback each did half of this.
    activateScenario: (presetRows: Array<Record<string, unknown>>) => { enqueue(() => {
      override = presetRows.map(presetRowToSpec);
      deps.forgeState.presets = override;
      compose();
    }); },
    clearScenario: () => { enqueue(() => {
      override = null;
      deps.forgeState.presets = dbPresets(); // in-process proxy back to DB presets — no ghosts
      compose();
    }); },
    setActiveRun: (runId: string | null) => { enqueue(() => { deps.forgeState.activeRunId = runId; compose(); }); },
    drain: () => chain,
  };
  stateServiceCache.set(deps.forgeState as unknown as object, svc);
  return svc;
}
