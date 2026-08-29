/** M1 gate: one real run through the orchestrator + live event capture. */
process.env['CRUCIBLE_DB_PATH'] = '/tmp/crucible-gate/gate.db';
process.env['CRUCIBLE_ARTIFACTS_DIR'] = '/tmp/crucible-gate/artifacts';
process.env['VITEST'] = 'true'; // silent logging

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// engine-canonical flow layout comes from the gitignored engines config (like production)
const enginesCfg = JSON.parse(readFileSync(join(homedir(), '.alloy', 'engines.local.json'), 'utf8')) as {
  engineB: { flowsDirSegments?: string[] };
};
const segments = enginesCfg.engineB.flowsDirSegments ?? ['flows'];

const { buildApp } = await import('../src/index.ts');
const { executeRun } = await import('../src/alloy/runner.ts');
const { initAlloyRuntime } = await import('../src/alloy/runtime.ts');

const app = await buildApp();
const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
for (const t of ['run.started', 'run.freshness.checked', 'step.started', 'step.finished', 'run.finished', 'device.changed'] as const) {
  app.bus.on(t, (p) => events.push({ type: t, payload: p as unknown as Record<string, unknown> }));
}

const UDID = '5640A847-E6A8-4293-A139-066B11F2CEA6';
console.log('G: starting run (Settings.app, real engines)...');
const t0 = Date.now();
const runId = await executeRun(
  {
    ticketKey: 'GATE-1',
    flowsDir: join('/tmp/crucible-gate', ...segments),
    udid: UDID,
    app: 'com.apple.Preferences',
    artifactPath: '/tmp/alloy-demo-app/LionParcel.app',
    srcPath: '/tmp/alloy-demo-app',
    triggeredBy: 'm1-gate',
  },
  { db: app.db.raw, bus: app.bus, artifactsDir: app.cfg.artifactsDir, dispatchDeps: (await initAlloyRuntime()).deps },
);
console.log(`run ${runId} finished in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// G2: steps appeared AS THEY EXECUTE (events interleave with run.finished last)
const stepFinished = events.filter((e) => e.type === 'step.finished').map((e) => e.payload);
const runFinishedAt = events.findIndex((e) => e.type === 'run.finished');
const lastStepAt = events.map((e) => e.type).lastIndexOf('step.finished');
console.log(`G2 steps-live: step.finished=${stepFinished.length}, run.finished after steps: ${runFinishedAt > lastStepAt}`);

// G3: fail flow shows fail + reason
const stepsRes = await app.app.inject({ method: 'GET', url: `/api/runs/${runId}/steps` });
const steps = (stepsRes.json() as { steps: Array<{ flow_name: string; status: string; reason: string | null }> }).steps;
console.log('G3 steps:', steps.map((s) => `${s.flow_name}:${s.status}${s.reason ? `(${s.reason.slice(0, 40)})` : ''}`).join(' | '));

// G4: matrix
const matrixRes = await app.app.inject({ method: 'GET', url: '/api/tickets/GATE-1/matrix' });
const matrix = matrixRes.json() as { status: string; acs: Array<{ ac_id: string; status: string }> };
console.log('G4 matrix:', matrix.status, JSON.stringify(matrix.acs.map((a) => `${a.ac_id}:${a.status}`)));

// G5: evidence video row + range
const evs = app.db.raw.prepare('SELECT id, type FROM evidence').all() as Array<{ id: string; type: string }>;
const video = evs.find((e) => e.type === 'video');
if (video) {
  const r1 = await app.app.inject({ method: 'GET', url: `/api/evidence/${video.id}/file`, headers: { range: 'bytes=0-99' } });
  console.log(`G5 video range: ${r1.statusCode} (206 expected), evidence rows: ${evs.length}`);
} else {
  console.log('G5 video: NO VIDEO evidence — FAIL');
}

// G6: freshness recorded
const run = app.db.raw.prepare('SELECT status, freshness FROM runs WHERE id = ?').get(runId) as { status: string; freshness: string };
console.log(`G6 run: status=${run.status} freshness=${run.freshness} (stale_ignored expected — fixture src is newer)`);

// G7: devices mirror populated
const devs = app.db.raw.prepare('SELECT udid, name FROM devices').all() as Array<{ udid: string; name: string | null }>;
console.log(`G7 devices mirror: ${devs.length} devices, first: ${devs[0]?.name ?? '—'}`);

await app.close();
console.log('GATE M1 DONE');
