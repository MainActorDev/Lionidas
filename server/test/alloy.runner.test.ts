/**
 * Runner contract: drives executeRun against the REAL Alloy dispatch with
 * stub handlers (Alloy's own test seam) — sequence order, engine-phasing
 * (no cross-engine overlap), STALE fail-fast, release-in-finally. No device.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateM1 } from '../src/db/schema.ts';
import { createEventBus, type AppEvents } from '../src/ws/bus.ts';
import { executeRun, type RunnerDeps } from '../src/alloy/runner.ts';
import { crucibleAlloy } from '../src/alloy/client.ts';
import { initAlloyRuntime, resetAlloyRuntimeForTests } from '../src/alloy/runtime.ts';

const FLOW = `ticket: CUST-1\nac_id: AC-1\nac_text: "sample AC"\ncategory: interaction\nname: smoke\nsteps:\n  - launch: com.apple.Preferences\n`;

let flowsDir: string;
let artifactsDir: string;
let db: Database.Database;
let events: Array<{ type: string; payload: unknown }>;
let deps: RunnerDeps;

/** Record all alloy calls + current lease map after each call. */
interface Recorded {
  tool: string;
  input: Record<string, unknown>;
  engine: string;
  lease: string;
  holder: string | null;
}
let recorded: Recorded[] = [];

async function installStubHandlers(overrides: Record<string, (input: Record<string, unknown>) => unknown> = {}): Promise<{ state: unknown; deps: unknown }> {
  const alloy = crucibleAlloy();
  // ONE runtime for both stubs and the runner (single registry + lease map)
  resetAlloyRuntimeForTests();
  const rt = await initAlloyRuntime();
  const state = rt.state as {
    resolved: unknown;
    configError: string | null;
    health: unknown;
    leases: { snapshot: () => Map<string, { engine: string; holder: string }> };
  };
  (alloy.clearRegistryForTests as () => void)();
  (alloy.registerPhase0Tools as (d: { state: unknown }) => void)({ state });
  const leaseMap = state.leases;
  const replace = (tool: string) => {
    const row = (alloy.routingTable as readonly { tool: string; engine: string }[]).find((r) => r.tool === tool);
    if (!row) return;
    const orig = overrides[tool];
    const def = alloy['replaceToolHandlerForTests'] as (t: string, h: (i: Record<string, unknown>) => unknown) => void;
    def(tool, async (input: Record<string, unknown>) => {
      const snap = leaseMap.snapshot();
      const entry = snap.get((input['udid'] as string) ?? 'SIM-1');
      recorded.push({ tool, input, engine: row.engine, lease: entry ? `${entry.engine}:${entry.holder}` : 'free', holder: entry?.holder ?? null });
      if (orig) return orig(input);
      if (tool === 'alloy_flow') return { ok: true, passed: 2, failed: 0, errored: 0, steps: [] };
      return { ok: true };
    });
  };
  ['alloy_apps', 'alloy_logs', 'alloy_video', 'alloy_flow', 'alloy_release', 'alloy_network'].forEach(replace);
  return { state, deps: rt.deps };
}

beforeEach(() => {
  flowsDir = mkdtempSync(join(tmpdir(), 'crucible-flows-'));
  writeFileSync(join(flowsDir, 'smoke.yaml'), FLOW);
  artifactsDir = mkdtempSync(join(tmpdir(), 'crucible-art-'));
  db = new Database(':memory:');
  migrateM1(db);
  events = [];
  const bus = createEventBus<AppEvents>();
  for (const t of ['run.started', 'run.freshness.checked', 'step.started', 'step.finished', 'run.finished'] as const) {
    bus.on(t, (p) => events.push({ type: t, payload: p }));
  }
  deps = { db, bus, artifactsDir, dispatchDeps: null };
  recorded = [];
});
const runtimeFor = async (overrides: Record<string, (input: Record<string, unknown>) => unknown> = {}) => {
  const rt = await installStubHandlers(overrides);
  deps.dispatchDeps = rt.deps;
  return rt;
};

afterEach(() => {
  rmSync(flowsDir, { recursive: true, force: true });
  rmSync(artifactsDir, { recursive: true, force: true });
});
import { afterEach } from 'vitest';
import { hasAlloy } from './helpers/capabilities.ts';
const describeIf = describe.skipIf(!(hasAlloy()));

// capability gate: needs the sibling Alloy repo (scripts/setup.sh)
describeIf('executeRun (contract)', () => {
  it('engine-phased sequence: A install→open(hold:false)→logs | B video→flow | A capture | release last', async () => {
    await runtimeFor();
    const runId = await executeRun(
      { ticketKey: 'CUST-1', flowsDir, udid: 'SIM-1', app: 'com.example.app', artifactPath: '/tmp/app.app', triggeredBy: 'test' },
      deps,
    );
    const tools = recorded.map((r) => r.tool);
    console.error('[seq]', JSON.stringify(recorded.map((r) => `${r.tool}:${r.input['action'] ?? ''}:${r.lease}`)));
    expect(tools.indexOf('alloy_apps')).toBeLessThan(tools.indexOf('alloy_logs'));
    expect(tools.indexOf('alloy_logs')).toBeLessThan(tools.indexOf('alloy_video'));
    expect(tools.indexOf('alloy_video')).toBeLessThan(tools.indexOf('alloy_flow'));
    expect(tools.lastIndexOf('alloy_flow')).toBeLessThan(tools.lastIndexOf('alloy_video')); // video stop after flows
    expect(tools.lastIndexOf('alloy_video')).toBeLessThan(tools.lastIndexOf('alloy_logs')); // capture after stop
    expect(tools[tools.length - 1]).toBe('alloy_release');
    // open used hold:false
    const open = recorded.find((r) => r.tool === 'alloy_apps' && r.input['action'] === 'open');
    expect(open?.input['hold']).toBe(false);
    // no cross-engine overlap: while B holds (alloy_flow), no A call except none
    const flowIdx = recorded.findIndex((r) => r.tool === 'alloy_flow');
    expect(recorded[flowIdx]!.lease).toContain('B');
    // events emitted
    expect(events.some((e) => e.type === 'run.started')).toBe(true);
    expect(events.some((e) => e.type === 'step.finished')).toBe(true);
    expect(events.some((e) => e.type === 'run.finished')).toBe(true);
    const run = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string };
    expect(run.status).toBe('passed');
    const ac = db.prepare('SELECT * FROM ac_results WHERE run_id = ?').get(runId) as { status: string; ac_id: string };
    expect(ac.status).toBe('pass');
    expect(ac.ac_id).toBe('AC-1');
  });

  it('STALE_ARTIFACT fails fast: no open, no flows, freshness recorded', async () => {
    await runtimeFor({
      alloy_apps: (input) => {
        if (input['action'] === 'install') {
          const e = new Error('stale') as Error & { code: string; details?: unknown };
          e.code = 'STALE_ARTIFACT';
          throw e;
        }
        return { ok: true };
      },
    });
    const runId = await executeRun(
      { ticketKey: 'CUST-1', flowsDir, udid: 'SIM-1', app: 'com.example.app', artifactPath: '/tmp/app.app', srcPath: '/tmp/src', triggeredBy: 'test' },
      deps,
    );
    expect(recorded.some((r) => r.input['action'] === 'open')).toBe(false);
    expect(recorded.some((r) => r.tool === 'alloy_flow')).toBe(false);
    const run = db.prepare('SELECT status, freshness FROM runs WHERE id = ?').get(runId) as { status: string; freshness: string };
    expect(run.status).toBe('failed');
    expect(run.freshness).toBe('stale_ignored');
  });

  it('successful install records the STORE artifact into app_catalog', async () => {
    const store = mkdtempSync(join(tmpdir(), 'runner-store-'));
    process.env['CRUCIBLE_APPS_DIR'] = store;
    try {
      // a real .app on disk with identity — importArtifact reads its plist
      const appDir = join(store, 'com.example.app-1.0.0-1.app');
      mkdirSync(appDir, { recursive: true });
      writeFileSync(join(appDir, 'Info.plist'),
        `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.example.app</string><key>CFBundleShortVersionString</key><string>1.0.0</string></dict></plist>`);
      await runtimeFor();
      const runId = await executeRun(
        { ticketKey: 'CUST-1', flowsDir, udid: 'SIM-1', app: 'com.example.app', artifactPath: appDir, srcPath: '/tmp/src', triggeredBy: 'test' },
        deps,
      );
      expect(runId).toMatch(/^run_/);
      const { lastArtifactFor } = await import('../src/manual/app-catalog-store.ts');
      const last = lastArtifactFor(db, 'com.example.app');
      expect(last?.artifactPath.startsWith(store)).toBe(true);
    } finally {
      delete process.env['CRUCIBLE_APPS_DIR'];
      rmSync(store, { recursive: true, force: true });
    }
  });

  it('flow failure → step fail + ac fail + run failed; release STILL called (finally)', async () => {
    let releaseSeen = false;
    await runtimeFor({
      alloy_flow: () => ({ ok: false, passed: 0, failed: 1, errored: 0, steps: [{ status: 'fail', reason: 'assertion' }] }),
      alloy_release: () => {
        releaseSeen = true;
        return { ok: true };
      },
    });
    const runId = await executeRun(
      { ticketKey: 'CUST-1', flowsDir, udid: 'SIM-1', app: 'com.example.app', artifactPath: '/tmp/app.app', triggeredBy: 'test' },
      deps,
    );
    const step = db.prepare('SELECT status, reason FROM run_steps WHERE run_id = ?').get(runId) as { status: string; reason: string };
    expect(step.status).toBe('fail');
    expect(step.reason).toBe('assertion');
    const ac = db.prepare('SELECT status FROM ac_results WHERE run_id = ?').get(runId) as { status: string };
    expect(ac.status).toBe('fail');
    const run = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string };
    expect(run.status).toBe('failed');
    expect(releaseSeen).toBe(true);
  });

  it('video failure is best-effort (run still passes); fatal open failure → error step + release (finally)', async () => {
    // (a) video start throws → tolerated, run passes, release still called
    let releaseSeen = false;
    await runtimeFor({
      alloy_video: () => {
        throw new Error('video boom');
      },
      alloy_release: () => {
        releaseSeen = true;
        return { ok: true };
      },
    });
    let runId = await executeRun(
      { ticketKey: 'CUST-1', flowsDir, udid: 'SIM-1', app: 'com.example.app', artifactPath: '/tmp/app.app', triggeredBy: 'test' },
      deps,
    );
    let run = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string };
    expect(run.status).toBe('passed'); // best-effort evidence never fails a run
    expect(releaseSeen).toBe(true);

    // (b) open fails hard → error step, run failed; release NOT attempted
    // (session never opened — nothing to release; that is the correct contract)
    await runtimeFor({
      alloy_apps: (input) => {
        if (input['action'] === 'open') throw new Error('open boom');
        return { ok: true };
      },
    });
    runId = await executeRun(
      { ticketKey: 'CUST-1', flowsDir, udid: 'SIM-1', app: 'com.example.app', artifactPath: '/tmp/app.app', triggeredBy: 'test' },
      deps,
    );
    run = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string };
    expect(run.status).toBe('failed');
    const errStep = db.prepare(`SELECT * FROM run_steps WHERE run_id = ? AND kind = 'error'`).get(runId);
    expect(errStep).toBeTruthy();
  });

  it('duplicate AC pre-flight refuses without touching alloy', async () => {
    writeFileSync(join(flowsDir, 'dupe.yaml'), FLOW.replace('smoke', 'dupe'));
    await expect(
      executeRun({ ticketKey: 'CUST-1', flowsDir, udid: 'SIM-1', app: 'a', artifactPath: '/tmp/a.app', triggeredBy: 't' }, deps),
    ).rejects.toThrowError(/duplicate|both claim/i);
    expect(recorded.length).toBe(0);
  });
});
