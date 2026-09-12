/** Readiness gate defaultAwaitStreamLive — the simdeckUrl contract.
 *  Regression: the gate destructured `streamUrl` while the resolve route
 *  returns `simdeckUrl` (wrapped device surface) → `fetch(undefined)` threw
 *  `Failed to parse URL from undefined` on every attempt → run aborted after
 *  the 30s budget. The gate must accept simdeckUrl as stream-live proof. */
import { describe, expect, it } from 'vitest';
import { runTemplatePlayback } from '../src/manual/playback.ts';

// The gate is a closure inside runTemplatePlayback with no direct export —
// exercised through the seam the abort tests use: deps.awaitStreamLive.
// Here we run the REAL default gate against a stubbed resolve route by NOT
// injecting awaitStreamLive; the fetch target is
// http://127.0.0.1:${CRUCIBLE_PORT}/api/devices/<udid>/stream.
// To keep this hermetic, point CRUCIBLE_PORT at an ephemeral listener that
// answers 200 {simdeckUrl} once, then assert the run proceeds past the gate
// (phase events observed) instead of aborting with the URL-parse error.
import { createServer, type Server } from 'node:http';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TypedEventBus, AppEvents } from '../src/ws/bus.ts';

describe('defaultAwaitStreamLive — simdeckUrl contract', () => {
  it('accepts simdeckUrl as stream-live proof (no fetch(undefined))', async () => {
    // ephemeral resolve-route stub
    let hits = 0;
    const srv: Server = await new Promise((res) => {
      const s = createServer((req, r) => {
        hits++;
        r.writeHead(200, { 'content-type': 'application/json' });
        r.end(JSON.stringify({ simdeckUrl: '/simdeck/simulators/U1' }));
      });
      s.listen(0, '127.0.0.1', () => res(s));
    });
    const port = (srv.address() as { port: number }).port;
    process.env['CRUCIBLE_PORT'] = String(port);

    const db = new Database(':memory:');
    const { migrateM1 } = await import('../src/db/schema.ts');
    migrateM1(db);
    const tmp = mkdtempSync(join(tmpdir(), 'gate-'));
    const phases: string[] = [];
    const bus = {
      on: () => () => undefined,
      emit: (type: string, payload?: { phase?: string }) => { if (type === 'run.phase' && payload?.phase) phases.push(payload.phase); },
    } as unknown as TypedEventBus<AppEvents>;
    db.prepare(`INSERT INTO templates(id, name, udid, steps_json, app_bundle_id, created_by, created_at, updated_at)
                VALUES ('t1','T','sim','[{"flow":"f","name":"noop","action":"expect_screen_contains","text":"x"}]', NULL, 'qa', 0, 0)`).run();
    db.prepare(`INSERT INTO devices(udid, name, state, last_seen) VALUES ('sim','Sim','Booted',?)`).run(Date.now());

    // minimal template; the run must clear the gate (simdeckUrl) and abort
    // LATER for an unrelated reason — NOT the URL-parse error.
    try {
      const r = await runTemplatePlayback({
        db, bus, dispatchDeps: null, artifactsDir: tmp,
        forgeState: { activeRunId: null },
      } as never, 't1', {}) as { done: Promise<unknown> };
      // the run body executes in the background — the gate fires inside it.
      // Race it against a hard timeout so a wedged run fails the test
      // instead of hanging it.
      await Promise.race([
        r.done.catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.log('THROWN:', msg.slice(0, 200));
          expect(msg).not.toContain('Failed to parse URL from undefined');
        }),
        new Promise((res) => setTimeout(res, 8_000)),
      ]);
      // DISCRIMINATOR (negative control verified 2026-09-12): the 'app'
      // phase fires only AFTER the gate passes. The unpatched gate swallows
      // the URL-parse TypeError into lastErr and retries for its whole 30s
      // budget — no 'app' phase within the race window — so this assertion
      // fails on the old code and passes on the fix.
      expect(phases).toContain('app');
    } finally {
      delete process.env['CRUCIBLE_PORT'];
      srv.close();
      rmSync(tmp, { recursive: true, force: true });
      db.close();
    }
    expect(hits).toBeGreaterThanOrEqual(1);
  });
});
