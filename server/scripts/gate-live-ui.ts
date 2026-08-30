/** Live-UI gate: WS endpoint streams events during a real run; queue.changed fires. */
process.env['CRUCIBLE_DB_PATH'] = '/tmp/crucible-gate/live-ui.db'; // NOT shared with the dev server — the dispatcher must be THIS process so bus events reach OUR WS client
process.env['CRUCIBLE_ARTIFACTS_DIR'] = '/tmp/crucible-gate/artifacts';

const { buildApp } = await import('../src/index.ts');

const app = await buildApp();
const results: Array<[string, boolean, string]> = [];
const check = (n: string, ok: boolean, info = '') => { results.push([n, ok, info]); console.log(`${ok ? '✓' : '✗'} ${n}${info ? ' — ' + info : ''}`); };

// ── WS connect against the REAL app (websocket via node 22+ native client) ──
const wsUrl = `ws://127.0.0.1:${app.cfg.port}/api/events`;
await app.app.listen({ port: app.cfg.port, host: '127.0.0.1' });

const received: Array<{ type: string }> = [];
const ws = new WebSocket(wsUrl);
await new Promise<void>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('ws connect timeout')), 4000);
  ws.onopen = () => { clearTimeout(t); resolve(); };
  ws.onerror = () => { clearTimeout(t); reject(new Error('ws error')); };
});
ws.onmessage = (m) => { received.push(JSON.parse(String(m.data)) as { type: string }); };
check('L1 WS /api/events connects', true);

// ── trigger a run through the queue and watch events stream ──
const UDID = '5640A847-E6A8-4293-A139-066B11F2CEA6';
app.db.raw.prepare(`INSERT OR REPLACE INTO devices(udid,name,state,last_seen) VALUES (?,'iPhone 16 Pro','Booted',?)`).run(UDID, Date.now());
const { readFileSync } = await import('node:fs');
const { join } = await import('node:path');
const { homedir } = await import('node:os');
const seg = (JSON.parse(readFileSync(join(homedir(), '.alloy', 'engines.local.json'), 'utf8')) as { engineB: { flowsDirSegments?: string[] } }).engineB.flowsDirSegments ?? ['flows'];
const FLOWS = join('/tmp/crucible-gate', ...seg);

const post = await fetch(`http://127.0.0.1:${app.cfg.port}/api/runs`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ ticketKey: 'LIVE-1', flowsDir: FLOWS, udid: UDID, app: 'com.apple.Preferences', artifactPath: '/tmp/alloy-demo-app/LionParcel.app', triggeredBy: 'live-gate', priority: 'manual' }),
});
check('L2 POST /api/runs via HTTP', post.status === 202);

// wait for the dispatcher (250ms tick) + run (~20s)
await new Promise((r) => setTimeout(r, 45_000));
ws.close();

const types = received.map((r) => r.type);
check('L3 queue.changed streamed', types.includes('queue.changed'), types.filter((t) => t === 'queue.changed').length + 'x');
check('L4 run.started streamed', types.includes('run.started'));
check('L5 step.started + step.finished streamed live', types.includes('step.started') && types.includes('step.finished'),
  `${types.filter((t) => t === 'step.finished').length} steps finished`);
check('L6 run.finished streamed', types.includes('run.finished'));
// events arrived DURING the run: step.finished before run.finished
const idxStep = types.lastIndexOf('step.finished');
const idxFinish = types.indexOf('run.finished');
check('L7 steps arrived BEFORE run.finished (live, not after)', idxStep !== -1 && idxFinish !== -1 && idxStep < idxFinish);

await app.close();
const failed = results.filter(([, ok]) => !ok);
console.log(`\nLIVE-UI GATE: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 2);
