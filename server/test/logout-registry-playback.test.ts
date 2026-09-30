import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTemplatePlayback } from '../src/manual/playback.ts';
import { migrateM1 } from '../src/db/schema.ts';
import { __setAlloyForTest } from '../src/alloy/client.ts';
import { __setAbortRegistryForTest } from '../src/manual/playback.ts';
import type { AlloyExports } from '../src/alloy/client.ts';

/** Plan 20260929T080249Z rev 2 stage 3 — bare `ensure logout:` resolves the
 *  app recipe from app_logout; inline keys WIN (case-level override);
 *  missing recipe fails closed; back: works with recipe-sourced via. */

let db: Database.Database;
let tmp: string;
const presses: Array<{ x: number; y: number; label?: string }> = [];
let nodesNow: Array<Record<string, unknown>> = [];
/** stateful press hook: recompute nodesNow per press (models the logout walk) */
let onPress: (() => void) | null = null;

function fakeAlloy(): AlloyExports {
  return {
    dispatch: async (tool: string, args: Record<string, unknown>) => {
      if (tool === 'alloy_apps') return { ok: true, apps: [] };
      // settle gate needs >= 2 nodes (root + UI) — prepend the root always
      if (tool === 'alloy_snapshot') return { ok: true, result: { nodes: [ROOT, ...nodesNow] } };
      if (tool === 'alloy_act' && (args as { action?: string }).action === 'press') {
        presses.push({ x: (args.target as { x: number }).x, y: (args.target as { y: number }).y });
        onPress?.();
        return { ok: true };
      }
      if (tool === 'alloy_screenshot') return { ok: true, result: { path: '/dev/null' } };
      return { ok: true, result: {} };
    },
  } as unknown as AlloyExports;
}

const bus = { emit: () => undefined } as never;

const ROOT = { index: 0, parentIndex: -1, type: 'Application', label: 'App', rect: { x: 0, y: 0, width: 393, height: 852 }, hittable: false, ref: 'root' };

const BUTTON = { index: 1, parentIndex: 0, type: 'Button', label: 'Log Out', identifier: 'account_logout_button', rect: { x: 100, y: 200, width: 80, height: 40 }, hittable: true, ref: 'n1' };
const CONFIRM = { index: 2, parentIndex: 0, type: 'Button', label: 'Confirm', identifier: 'account_logout_confirm_button', rect: { x: 100, y: 400, width: 80, height: 40 }, hittable: true, ref: 'n2' };
const HOME_TAB = { index: 3, parentIndex: 0, type: 'Button', label: 'Home', rect: { x: 40, y: 820, width: 60, height: 30 }, hittable: true, ref: 'n3' };

function seed(templateId: string, setup: unknown[]): void {
  db.prepare(`INSERT INTO templates(id, name, setup_json, steps_json, tags_json, udid, app_bundle_id, created_by, created_at, updated_at)
              VALUES (?, ?, ?, ?, '[]', '', NULL, 'qa', 1, 1)`).run(templateId, templateId, JSON.stringify(setup), JSON.stringify([{ idx: 0, action: 'expect', selector: { label: 'Done' } }]));
}

async function play(id: string): Promise<{ runId: string; status: string; steps: Array<{ idx: number; status: string; reason: string | null }> }> {
  const r = await runTemplatePlayback({ db, bus, dispatchDeps: null, artifactsDir: tmp, forgeState: { activeRunId: null }, awaitStreamLive: async () => undefined, listApps: async () => [] } as never, id, { bundleId: 'com.example.app' });
  await r.done;
  const run = db.prepare('SELECT status FROM runs WHERE id = ?').get(r.runId) as { status: string };
  const steps = db.prepare('SELECT idx, status, reason FROM run_steps WHERE run_id = ? ORDER BY idx').all(r.runId) as Array<{ idx: number; status: string; reason: string | null }>;
  return { runId: r.runId, status: run.status, steps };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'logout-registry-'));
  db = new Database(':memory:');
  migrateM1(db);
  presses.length = 0;
  __setAlloyForTest(fakeAlloy());
  process.env.CRUCIBLE_SETTLE_MS = '10';
  process.env.CRUCIBLE_SETTLE_POLL_MS = '5';
  process.env.CRUCIBLE_STEP_TIMEOUT_MS = '4000';
  __setAbortRegistryForTest();
});

describe('bare ensure logout — registry resolution', () => {
  it('resolves the app recipe: session visible → real logout walk via recipe ids', async () => {
    db.prepare("INSERT INTO app_logout(bundle_id, logout_json, updated_at, revision) VALUES ('com.example.app', ?, 0, 1)")
      .run(JSON.stringify({ button: 'account_logout_button', confirm: 'account_logout_confirm_button' }));
    seed('tpl_reg', [{ idx: 0, action: 'ensureLogout', ensureLogout: { recipe: 'app' } }]);
    nodesNow = [BUTTON, CONFIRM, HOME_TAB] as never as Array<Record<string, unknown>>;
    // stateful: press #1 (button) → sheet up (confirm only); press #2 (confirm) → logged out (no session nodes)
    onPress = () => {
      if (presses.length === 1) nodesNow = [CONFIRM, HOME_TAB] as never as Array<Record<string, unknown>>;
      else nodesNow = [HOME_TAB] as never as Array<Record<string, unknown>>;
    };
    const out = await play('tpl_reg');
    onPress = null;
    expect(out.steps[0]!.status).toBe('pass');
    expect(out.steps[0]!.reason).toContain('session logged out');
  });

  it('no recipe registered → fail closed naming the fix (never silent pass)', async () => {
    seed('tpl_missing', [{ idx: 0, action: 'ensureLogout', ensureLogout: { recipe: 'app' } }]);
    nodesNow = [HOME_TAB]; // some UI (settle gate) but NO session button → still must fail closed
    const out = await play('tpl_missing');
    expect(out.steps[0]!.status).toBe('fail');
    expect(out.steps[0]!.reason).toContain('no logout flow registered');
  });

  it('inline keys WIN over the registry (case-level override)', async () => {
    db.prepare("INSERT INTO app_logout(bundle_id, logout_json, updated_at, revision) VALUES ('com.example.app', ?, 0, 1)")
      .run(JSON.stringify({ button: 'recipe_button', confirm: 'recipe_confirm' }));
    // inline targets a DIFFERENT button id — only that one exists
    const inlineBtn = { ...BUTTON, identifier: 'inline_button' };
    nodesNow = [inlineBtn, CONFIRM, HOME_TAB] as never as Array<Record<string, unknown>>;
    seed('tpl_inline', [{ idx: 0, action: 'ensureLogout', ensureLogout: { button: 'inline_button', stay: '', confirm: 'account_logout_confirm_button' } }]);
    onPress = () => {
      if (presses.length === 1) nodesNow = [CONFIRM, HOME_TAB] as never as Array<Record<string, unknown>>;
      else nodesNow = [HOME_TAB] as never as Array<Record<string, unknown>>;
    };
    const out = await play('tpl_inline');
    onPress = null;
    expect(out.steps[0]!.status).toBe('pass');
    expect(out.steps[0]!.reason).toContain('session logged out');
  });

  it('recipe via + step back: via taps through, back returns after already-logged-out', async () => {
    db.prepare("INSERT INTO app_logout(bundle_id, logout_json, updated_at, revision) VALUES ('com.example.app', ?, 0, 1)")
      .run(JSON.stringify({ button: 'account_logout_button', confirm: 'account_logout_confirm_button', via: 'ic_tab' }));
    const TAB = { index: 4, parentIndex: 0, type: 'Button', label: '', identifier: 'ic_tab', rect: { x: 40, y: 890, width: 40, height: 30 }, hittable: true, ref: 'n4' };
    seed('tpl_back', [{ idx: 0, action: 'ensureLogout', ensureLogout: { recipe: 'app', back: 'Home' } }]);
    nodesNow = [TAB, HOME_TAB] as never as Array<Record<string, unknown>>; // via present, no session → already logged out; back taps Home
    const out = await play('tpl_back');
    expect(out.steps[0]!.status).toBe('pass');
    expect(out.steps[0]!.reason).toContain('already logged out');
    // presses: via tap + back tap (no logout walk)
    expect(presses.length).toBe(2);
  });
});

import { afterEach } from 'vitest';
afterEach(() => {
  __setAlloyForTest(null);
  delete process.env.CRUCIBLE_SETTLE_MS;
  delete process.env.CRUCIBLE_SETTLE_POLL_MS;
  delete process.env.CRUCIBLE_STEP_TIMEOUT_MS;
  delete (globalThis as Record<string, unknown>).__swap;
  rmSync(tmp, { recursive: true, force: true });
});
