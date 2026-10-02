/** Parallel dispatch regression (plan steps_002): the dispatcher must start
 *  runs on DIFFERENT devices concurrently (overlapping executeRun calls),
 *  while a busy device still serializes its own queue. Uses deferred
 *  executeRun stubs so overlap is observable without wall-clock timing. */
import { describe, expect, it, beforeEach, vi } from 'vitest';

// mock the runner at the dispatcher's import site — overlap observable via
// deferred executeRun stubs (no wall-clock timing)
const started: string[] = [];
const pending = new Map<string, () => void>();
vi.mock('../src/alloy/runner.ts', () => ({
  executeRun: vi.fn(async (spec: { udid: string }) => {
    const runId = `run_${spec.udid}`;
    started.push(spec.udid);
    await new Promise<void>((res) => pending.set(runId, res));
    return runId;
  }),
}));

import Database from 'better-sqlite3';
import { migrateM1 } from '../src/db/schema.ts';
import { enqueue, type QueueSpec } from '../src/queue/store.ts';
import { dispatchTick, type DispatcherDeps } from '../src/queue/dispatcher.ts';

let db: Database.Database;
const mkSpec = (udid: string): QueueSpec => ({
  ticketKey: 'PAR-1', flowsDir: '/tmp/f', udid, app: 'a', artifactPath: '/tmp/a.app', triggeredBy: 't',
});

function mkDeps(): DispatcherDeps {
  return { db, bus: { emit: () => undefined, on: () => () => undefined } as never } as unknown as DispatcherDeps;
}
function resolve(runId: string): void { pending.get(runId)?.(); }

beforeEach(() => {
  db = new Database(':memory:');
  migrateM1(db);
});

describe('parallel dispatch (different devices)', () => {
  it('two entries, two devices: dispatch overlaps without waiting', async () => {
    enqueue(db, mkSpec('SIM-A'), 'op', 0);
    enqueue(db, mkSpec('SIM-B'), 'op', 0);
    const deps = mkDeps();

    // tick 1 dispatches SIM-A (executeRun pending — the "run is running")
    const t1 = dispatchTick(deps as never);
    // tick 2 fires while run A is STILL executing — must dispatch SIM-A's peer
    const t2 = dispatchTick(deps as never);
    // let the event loop settle without resolving either run
    await new Promise((r) => setTimeout(r, 20));

    expect(started).toEqual(['SIM-A', 'SIM-B']); // overlap proven: B started before A finished

    resolve('run_SIM-A');
    resolve('run_SIM-B');
    await Promise.all([t1, t2]);
    const states = db.prepare(`SELECT state FROM queue ORDER BY id`).all() as Array<{ state: string }>;
    expect(states.every((s) => s.state === 'done')).toBe(true);
  });

  it('same device: second entry waits while the first run is active', async () => {
    enqueue(db, mkSpec('SIM-A'), 'op', 0);
    enqueue(db, mkSpec('SIM-A'), 'op', 0);
    const deps = mkDeps();

    const t1 = dispatchTick(deps as never);
    await new Promise((r) => setTimeout(r, 20));
    // executeRun's run row insert is stubbed away, so emulate the busy mark the
    // real executeRun creates (runs row for SIM-A):
    db.prepare(`INSERT INTO runs(id,ticket_key,kind,status,triggered_by,device_udid) VALUES ('run_SIM-A','PAR-1','automated','running','op','SIM-A')`).run();
    const before = started.length;
    await dispatchTick(deps as never); // must NOT start the second SIM-A entry
    expect(started.length).toBe(before);
    resolve('run_SIM-A');
    await t1;
  });
});
