/** POST /api/runs fan-out (plan steps_003/R4): udids[] / allBooted queue the
 *  same spec on several devices; single-udid shape is byte-compatible. */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// scanFlowSet needs a real flows dir with one flow file
function flowsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'flows-'));
  writeFileSync(join(dir, 'flowA.yaml'), 'ticket: FAN-1\nac_id: AC-1\nac_text: smoke\n');
  return dir;
}

async function buildApp(): Promise<{ app: FastifyInstance; db: Database.Database; flows: string; artifact: string }> {
  const db = new Database(':memory:');
  const { migrateM1 } = await import('../src/db/schema.ts');
  migrateM1(db);
  db.prepare(`INSERT INTO devices (udid, name, state, kind, last_seen) VALUES ('SIM-A', 'A', 'Booted', 'simulator', 1), ('SIM-B', 'B', 'Booted', 'simulator', 1), ('SIM-C', 'C', 'Shutdown', 'simulator', 1)`).run();
  const flows = flowsDir();
  const artifact = mkdtempSync(join(tmpdir(), 'app-'));
  const app = Fastify();
  app.addHook('onRequest', async (req: import('fastify').FastifyRequest) => { (req as unknown as { user: unknown }).user = { name: 'op', role: 'operator' }; });
  // minimal route registration: re-import the real handler? The route file registers many routes needing full schema.
  // Instead: register ONLY the POST /api/runs logic via the real module with a stubbed environment is heavy —
  // the fan-out logic lives inline in routes/runs.ts. For unit coverage we exercise it through the real register
  // if cheap; otherwise this test targets the route through the full app elsewhere. Here: inline the module.
  const { registerRunRoutes } = await import('../src/routes/runs.ts');
  registerRunRoutes(app, db, { emit: () => undefined, on: () => () => undefined } as never);
  // seed env the route reads
  process.env['CRUCIBLE_ARTIFACTS_DIR'] = mkdtempSync(join(tmpdir(), 'art-'));
  return { app, db, flows, artifact };
}

describe('POST /api/runs fan-out', () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  beforeEach(async () => { ctx = await buildApp(); });
  afterEach(async () => { await ctx.app.close(); ctx.db.close(); rmSync(ctx.flows, { recursive: true, force: true }); });

  const base = { ticketKey: 'FAN-1', flowsDir: '', app: 'com.x', artifactPath: '', triggeredBy: 'op' };

  it('single udid: response shape unchanged ({queueId})', async () => {
    const r = await ctx.app.inject({ method: 'POST', url: '/api/runs', payload: { ...base, flowsDir: ctx.flows, artifactPath: ctx.artifact, udid: 'SIM-A' } });
    expect(r.statusCode).toBe(202);
    expect(typeof (r.json() as { queueId: string }).queueId).toBe('string');
    expect(ctx.db.prepare(`SELECT COUNT(*) c FROM queue WHERE state='waiting'`).get()).toMatchObject({ c: 1 });
  });

  it('udids[]: one queue entry per device, queueIds[] response', async () => {
    const r = await ctx.app.inject({ method: 'POST', url: '/api/runs', payload: { ...base, flowsDir: ctx.flows, artifactPath: ctx.artifact, udids: ['SIM-A', 'SIM-B'] } });
    expect(r.statusCode).toBe(202);
    const ids = (r.json() as { queueIds: string[] }).queueIds;
    expect(ids).toHaveLength(2);
    const specs = (ctx.db.prepare(`SELECT spec_json FROM queue WHERE state='waiting'`).all() as Array<{ spec_json: string }>).map((row) => JSON.parse(row.spec_json) as { udid: string });
    expect(specs.map((s) => s.udid).sort()).toEqual(['SIM-A', 'SIM-B']);
  });

  it('allBooted: resolves booted devices only', async () => {
    const r = await ctx.app.inject({ method: 'POST', url: '/api/runs', payload: { ...base, flowsDir: ctx.flows, artifactPath: ctx.artifact, allBooted: true } });
    expect(r.statusCode).toBe(202);
    expect((r.json() as { queueIds: string[] }).queueIds).toHaveLength(2); // A + B, not C
  });

  it('unknown udid in list: 400 naming the offender, nothing queued', async () => {
    const r = await ctx.app.inject({ method: 'POST', url: '/api/runs', payload: { ...base, flowsDir: ctx.flows, artifactPath: ctx.artifact, udids: ['SIM-A', 'NOPE'] } });
    expect(r.statusCode).toBe(400);
    expect((r.json() as { error: string }).error).toContain('NOPE');
    expect(ctx.db.prepare(`SELECT COUNT(*) c FROM queue`).get()).toMatchObject({ c: 0 });
  });

  it('two target fields at once: 400', async () => {
    const r = await ctx.app.inject({ method: 'POST', url: '/api/runs', payload: { ...base, flowsDir: ctx.flows, artifactPath: ctx.artifact, udid: 'SIM-A', allBooted: true } });
    expect(r.statusCode).toBe(400);
  });
});
