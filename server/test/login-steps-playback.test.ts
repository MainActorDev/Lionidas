import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTemplatePlayback, __setAbortRegistryForTest } from '../src/manual/playback.ts';
import { migrateM1 } from '../src/db/schema.ts';
import { __setAlloyForTest } from '../src/alloy/client.ts';
import type { AlloyExports } from '../src/alloy/client.ts';

/** Plan 20260930T044550Z rev 2 stage 3 — steps-form login recipe playback:
 *  recipe steps play through the shared primitives (settleFind/press/
 *  resilientFill+dismissKeyboard); already-logged-in no-op; OTP shape;
 *  fail-closed on missing recipe; legacy screen-form back-compat. */

let db: Database.Database;
let tmp: string;
const fills: Array<{ x: number; y: number; text: string }> = [];
const presses: Array<{ x: number; y: number }> = [];
let nodesNow: Array<Record<string, unknown>> = [];
let fillResult: { ok: true } | { ok: false; error: { message: string } } = { ok: true };

const ROOT = { index: 0, parentIndex: -1, type: 'Application', label: 'App', rect: { x: 0, y: 0, width: 393, height: 852 }, hittable: false, ref: 'root' };
const N = (i: number, id: string, x = 100, y = 200): Record<string, unknown> => ({ index: i, parentIndex: 0, type: 'Button', label: '', identifier: id, rect: { x, y, width: 80, height: 40 }, hittable: true, ref: `n${i}` });

function fakeAlloy(): AlloyExports {
  return {
    dispatch: async (tool: string, args: Record<string, unknown>) => {
      if (tool === 'alloy_apps') return { ok: true, apps: [] };
      if (tool === 'alloy_snapshot') return { ok: true, result: { nodes: [ROOT, ...nodesNow] } };
      if (tool === 'alloy_act') {
        const act = args.action as string;
        const tgt = args.target as { x: number; y: number };
        if (act === 'press') { presses.push({ x: tgt.x, y: tgt.y }); return { ok: true }; }
        if (act === 'fill') { fills.push({ x: tgt.x, y: tgt.y, text: String(args.text ?? '') }); return fillResult; }
        if (act === 'keyboardDismiss') return { ok: true };
        return { ok: true };
      }
      if (tool === 'alloy_screenshot') return { ok: true, result: { path: '/dev/null' } };
      return { ok: true, result: {} };
    },
  } as unknown as AlloyExports;
}

const bus = { emit: () => undefined } as never;

function seed(id: string, setup: unknown[], env: Record<string, string> = {}): void {
  db.prepare(`INSERT INTO templates(id, name, setup_json, steps_json, tags_json, udid, app_bundle_id, created_by, created_at, updated_at)
              VALUES (?, ?, ?, ?, '[]', '', NULL, 'qa', 1, 1)`)
    .run(id, id, JSON.stringify(setup), JSON.stringify([{ idx: 0, action: 'expect', selector: { label: 'Done' } }]));
  for (const [k, v] of Object.entries(env)) {
    db.prepare(`INSERT INTO env_vars(id, scope, app_bundle_id, key, value, updated_by, updated_at)
                VALUES (?, 'global', NULL, ?, ?, 'qa', 0)`).run(`ev_${k}_${id}`, k, v);
  }
}

async function play(id: string): Promise<{ status: string; steps: Array<{ idx: number; status: string; reason: string | null }> }> {
  const r = await runTemplatePlayback({ db, bus, dispatchDeps: null, artifactsDir: tmp, forgeState: { activeRunId: null }, awaitStreamLive: async () => undefined, listApps: async () => [] } as never, id, { bundleId: 'com.example.app' });
  await r.done;
  const run = db.prepare('SELECT status FROM runs WHERE id = ?').get(r.runId) as { status: string };
  const steps = db.prepare('SELECT idx, status, reason FROM run_steps WHERE run_id = ? ORDER BY idx').all(r.runId) as Array<{ idx: number; status: string; reason: string | null }>;
  return { status: run.status, steps };
}

const PW_RECIPE = (phoneEnv = 'DRILL_PHONE', pwEnv = 'DRILL_PASSWORD'): string => JSON.stringify({
  entry: { navigate: [{ on: 'open_login' }] },
  steps: [
    { type: { on: 'phone_field', text: `\${env.${phoneEnv}}` } },
    { type: { on: 'password_field', text: `\${env.${pwEnv}}` } },
    { tap: { on: 'submit_button' } },
  ],
  verify: { screen: 'auth', state: 'session_on' },
});

const AUTH_STATES = JSON.stringify({ session_on: { all: [{ identifier: 'session_badge' }] }, logged_out: { all: [{ identifier: 'open_login' }] } });

function seedAppScreens(): void {
  db.prepare(`INSERT INTO app_screens(app_bundle_id, screen_id, entry_json, refresh_json, states_json, updated_at, revision)
              VALUES ('com.example.app', 'auth', '{}', NULL, ?, 0, 1)`).run(AUTH_STATES);
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'login-steps-'));
  db = new Database(':memory:');
  migrateM1(db);
  fills.length = 0;
  presses.length = 0;
  nodesNow = [];
  fillResult = { ok: true };
  __setAlloyForTest(fakeAlloy());
  process.env.CRUCIBLE_SETTLE_MS = '10';
  process.env.CRUCIBLE_SETTLE_POLL_MS = '5';
  process.env.CRUCIBLE_STEP_TIMEOUT_MS = '4000';
  __setAbortRegistryForTest();
});

import { afterEach } from 'vitest';
afterEach(() => {
  __setAlloyForTest(null);
  delete process.env.CRUCIBLE_SETTLE_MS;
  delete process.env.CRUCIBLE_SETTLE_POLL_MS;
  delete process.env.CRUCIBLE_STEP_TIMEOUT_MS;
  rmSync(tmp, { recursive: true, force: true });
});

describe('steps-form login recipe playback', () => {
  it('plays entry → fills both fields (env-expanded) → taps submit → state holds', async () => {
    seedAppScreens();
    db.prepare("INSERT INTO app_login(bundle_id, login_json, updated_at, revision) VALUES ('com.example.app', ?, 0, 1)").run(PW_RECIPE());
    seed('tpl_pw', [{ idx: 0, action: 'ensureLogin', ensureLogin: { recipe: 'app' } }], { DRILL_PHONE: '111', DRILL_PASSWORD: 'pw9' });
    // walk: navigate tap(open_login) → type phone → type pw → tap submit → verify session_badge appears
    nodesNow = [N(1, 'open_login'), N(2, 'phone_field', 10, 100), N(3, 'password_field', 10, 150), N(4, 'submit_button', 10, 250)];
    const stateMachine: Array<() => void> = [];
    let submitTapped = false;
    (globalThis as Record<string, unknown>).__sm = null;
    // simple: on press of submit_button (10+40, 250+20), reveal session_badge
    const origDispatchLen = () => presses.length;
    const r = await (async () => {
      const patch = setInterval(() => {
        if (presses.some(p => p.x === 50 && p.y === 270) && !submitTapped) {
          submitTapped = true;
          nodesNow = [N(5, 'session_badge', 20, 20)];
        }
      }, 30);
      const out = await play('tpl_pw');
      clearInterval(patch);
      return out;
    })();
    expect(r.steps[0]!.status).toBe('pass');
    expect(r.steps[0]!.reason).toContain('logged in');
    // fills: phone then password, env-expanded
    expect(fills.map(f => f.text)).toEqual(['111', 'pw9']);
    // form already up (phone_field visible) → entry tap SKIPPED (scene-restore
    // semantics) → presses = submit only
    expect(presses.length).toBe(1);
  });

  it('OTP shape: type → tap send → type code → tap verify', async () => {
    seedAppScreens();
    db.prepare("INSERT INTO app_login(bundle_id, login_json, updated_at, revision) VALUES ('com.example.app', ?, 0, 1)").run(JSON.stringify({
      entry: { navigate: [{ on: 'open_login' }] },
      steps: [
        { type: { on: 'phone_field', text: '${env.OTP_PHONE}' } },
        { tap: { on: 'send_code' } },
        { type: { on: 'code_field', text: '${env.OTP_CODE}' } },
        { tap: { on: 'verify_button' } },
      ],
      verify: { screen: 'auth', state: 'session_on' },
    }));
    seed('tpl_otp', [{ idx: 0, action: 'ensureLogin', ensureLogin: { recipe: 'app' } }], { OTP_PHONE: '62', OTP_CODE: '998877' });
    nodesNow = [N(1, 'open_login'), N(2, 'phone_field', 10, 100), N(3, 'send_code', 10, 150), N(4, 'code_field', 10, 200), N(5, 'verify_button', 10, 250)];
    let verified = false;
    const patch = setInterval(() => {
      if (presses.some(p => p.x === 50 && p.y === 270) && !verified) {
        verified = true;
        nodesNow = [N(6, 'session_badge', 20, 20)];
      }
    }, 30);
    const r = await play('tpl_otp');
    clearInterval(patch);
    expect(r.steps[0]!.status).toBe('pass');
    expect(fills.map(f => f.text)).toEqual(['62', '998877']);
    expect(presses.length).toBe(2); // send_code + verify (entry skipped: form up)
  });

  it('already logged in (state holds) → no-op pass, zero fills', async () => {
    seedAppScreens();
    db.prepare("INSERT INTO app_login(bundle_id, login_json, updated_at, revision) VALUES ('com.example.app', ?, 0, 1)").run(PW_RECIPE());
    seed('tpl_in', [{ idx: 0, action: 'ensureLogin', ensureLogin: { recipe: 'app' } }], { DRILL_PHONE: '1', DRILL_PASSWORD: 'x' });
    nodesNow = [N(1, 'session_badge', 20, 20)];
    const r = await play('tpl_in');
    expect(r.steps[0]!.status).toBe('pass');
    expect(r.steps[0]!.reason).toContain('already logged in');
    expect(fills.length).toBe(0);
  });

  it('no recipe → fail closed naming the fix', async () => {
    seed('tpl_none', [{ idx: 0, action: 'ensureLogin', ensureLogin: { recipe: 'app' } }]);
    nodesNow = [N(1, 'x')];
    const r = await play('tpl_none');
    expect(r.steps[0]!.status).toBe('fail');
    expect(r.steps[0]!.reason).toContain('login flow');
  });

  it('legacy screen-form case (pre-migration) still resolves the app recipe', async () => {
    seedAppScreens();
    db.prepare("INSERT INTO app_login(bundle_id, login_json, updated_at, revision) VALUES ('com.example.app', ?, 0, 1)").run(PW_RECIPE());
    seed('tpl_legacy', [{ idx: 0, action: 'ensureLogin', ensureLogin: { screen: 'auth', phone: '${env.DRILL_PHONE}', password: '${env.DRILL_PASSWORD}', entry: '', phoneField: '', passwordField: '', submit: '', session: '' } }], { DRILL_PHONE: '1', DRILL_PASSWORD: 'x' });
    nodesNow = [N(1, 'open_login'), N(2, 'phone_field', 10, 100), N(3, 'password_field', 10, 150), N(4, 'submit_button', 10, 250)];
    let submitTapped = false;
    const patch = setInterval(() => {
      if (presses.some(p => p.x === 50 && p.y === 270) && !submitTapped) {
        submitTapped = true;
        nodesNow = [N(5, 'session_badge', 20, 20)];
      }
    }, 30);
    const r = await play('tpl_legacy');
    clearInterval(patch);
    expect(r.steps[0]!.status).toBe('pass');
    expect(fills.map(f => f.text)).toEqual(['1', 'x']);
  });

  it('resilient fill: unconfirmed masked fill with glyph parity → tolerated, not retried into corruption', async () => {
    seedAppScreens();
    db.prepare("INSERT INTO app_login(bundle_id, login_json, updated_at, revision) VALUES ('com.example.app', ?, 0, 1)").run(PW_RECIPE());
    seed('tpl_mask', [{ idx: 0, action: 'ensureLogin', ensureLogin: { recipe: 'app' } }], { DRILL_PHONE: '111', DRILL_PASSWORD: 'quality123' });
    nodesNow = [N(1, 'open_login'), N(2, 'phone_field', 10, 100), N(3, 'password_field', 10, 150), N(4, 'submit_button', 10, 250)];
    // password fill: engine reports mask mismatch with glyph count == text length → tolerant pass
    let pwSeen = false;
    const origDispatch = (globalThis as Record<string, unknown>).__nothing;
    fillResult = { ok: false, error: { message: 'text entry verification failed: expected quality123, observed "⬤ ⬤ ⬤ ⬤ ⬤ ⬤ ⬤ ⬤ ⬤ ⬤"' } } as never;
    // per-call switching: phone fill ok, password fill fails-with-parity. Patch via a proxy on fills:
    let fillCount = 0;
    __setAlloyForTest({
      dispatch: async (tool: string, args: Record<string, unknown>) => {
        if (tool === 'alloy_apps') return { ok: true, apps: [] };
        if (tool === 'alloy_snapshot') return { ok: true, result: { nodes: [ROOT, ...nodesNow] } };
        if (tool === 'alloy_act') {
          const act = args.action as string;
          const tgt = args.target as { x: number; y: number };
          if (act === 'press') { presses.push({ x: tgt.x, y: tgt.y }); if (tgt.x === 50 && tgt.y === 270) nodesNow = [N(5, 'session_badge', 20, 20)]; return { ok: true }; }
          if (act === 'fill') {
            fills.push({ x: tgt.x, y: tgt.y, text: String(args.text ?? '') });
            if (String(args.text ?? '') === 'quality123') return { ok: false, error: { message: 'text entry verification failed: expected quality123, observed "⬤ ⬤ ⬤ ⬤ ⬤ ⬤ ⬤ ⬤ ⬤ ⬤"' } };
            return { ok: true };
          }
          return { ok: true };
        }
        if (tool === 'alloy_screenshot') return { ok: true, result: { path: '/dev/null' } };
        return { ok: true, result: {} };
      },
    } as unknown as AlloyExports);
    const r = await play('tpl_mask');
    expect(r.steps[0]!.status).toBe('pass');
    // exactly 2 fills: phone ok, pw parity-tolerated — NO clear+retype corruption
    expect(fills.map(f => f.text)).toEqual(['111', 'quality123']);
  });
});
