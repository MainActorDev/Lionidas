import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrateM1 } from '../src/db/schema.ts';
import { enqueue, nextDispatchable, markDone, abort, backoffOrAbort, type QueueSpec } from '../src/queue/store.ts';

let db: Database.Database;
const mkSpec = (udid = 'SIM-1'): QueueSpec => ({
  ticketKey: 'CUST-1', flowsDir: '/tmp/f', udid, app: 'a', artifactPath: '/tmp/a.app', triggeredBy: 't',
});

beforeEach(() => {
  db = new Database(':memory:');
  migrateM1(db);
});

describe('queue ordering', () => {
  it('priority asc: manual picked before agent despite later enqueue', () => {
    const agent = enqueue(db, mkSpec(), 'bot', 2);
    const manual = enqueue(db, mkSpec(), 'human', 0);
    const next = nextDispatchable(db);
    expect(next?.id).toBe(manual);
    expect(next?.id).not.toBe(agent);
  });
  it('FIFO within class', () => {
    const a = enqueue(db, mkSpec('SIM-1'), 'x', 2);
    enqueue(db, mkSpec('SIM-2'), 'y', 2);
    const next = nextDispatchable(db);
    expect(next?.id).toBe(a);
  });
  it('busy device skipped; free other device picked', () => {
    db.prepare(`INSERT INTO runs(id,ticket_key,kind,status,triggered_by,device_udid) VALUES ('r1','T','automated','running','x','SIM-1')`).run();
    enqueue(db, mkSpec('SIM-1'), 'x', 0);
    const other = enqueue(db, mkSpec('SIM-2'), 'x', 2);
    expect(nextDispatchable(db)?.id).toBe(other);
  });
  it('starvation: agent defers when manual waited > 60s', () => {
    const manual = enqueue(db, mkSpec('SIM-2'), 'h', 0);
    db.prepare(`UPDATE queue SET enqueued_at = enqueued_at - 61000 WHERE id = ?`).run(manual);
    // manual targets SIM-2; agent on SIM-1 (free) must defer
    const agent = enqueue(db, mkSpec('SIM-1'), 'b', 2);
    expect(nextDispatchable(db)?.id).toBe(manual);
    // agent not dispatchable while manual starves
    markDone(db, manual);
    expect(nextDispatchable(db)?.id).toBe(agent);
  });
  it('abort only waiting entries', () => {
    const id = enqueue(db, mkSpec(), 'x', 0);
    expect(abort(db, id)).toBe(true);
    expect(abort(db, id)).toBe(false); // already aborted
  });
});

describe('queue LEASE_HELD backoff', () => {
  it('backoff x3 then abort', () => {
    const id = enqueue(db, mkSpec(), 'x', 0);
    const attempts = new Map<string, number>();
    expect(backoffOrAbort(db, id, attempts)).toBe('requeued');
    expect(backoffOrAbort(db, id, attempts)).toBe('requeued');
    expect(backoffOrAbort(db, id, attempts)).toBe('aborted');
    const row = db.prepare('SELECT state FROM queue WHERE id = ?').get(id) as { state: string };
    expect(row.state).toBe('aborted');
  });
});
