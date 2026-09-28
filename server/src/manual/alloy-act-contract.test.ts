/** alloy_act payload contract (2026-09-28): every act payload playback can
 *  build must satisfy alloy's REAL routing schema. Born from a live catch —
 *  the ensure-logout branch shipped `action:'tap', x, y` (an action that does
 *  not exist; alloy only knows press|fill|scroll|longpress|keyboardDismiss).
 *  The fake-alloy unit path can't catch this: fakes don't validate payloads.
 *
 *  Two tiers:
 *  1. Sibling alloy present (dev machines): payloads are validated against
 *     alloy's LIVE zod schema imported from its dist. Drift fails HERE first.
 *  2. No sibling (CI): a pinned mirror of the alloy_act contract
 *     (verbs + required fields) is asserted instead — hermetic, no network.
 *  The mirror's source of truth is alloy src/routing.ts alloy_act row; a
 *  comment there (search "Lionidas mirror") points back at this file. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTemplatePlayback } from './playback.ts';
import { migrateM1 } from '../db/schema.ts';
import { __setAlloyForTest } from '../alloy/client.ts';
import type { AlloyExports } from '../alloy/client.ts';

/** alloy_act contract mirror (source: alloy src/routing.ts, alloy_act row).
 *  KEEP IN SYNC — tier 1 validates against the live schema when the sibling
 *  repo exists, so dev machines catch drift the moment alloy changes. */
const MIRRORED_ACT_CONTRACT = {
  actions: ['press', 'fill', 'scroll', 'longpress', 'keyboardDismiss'] as const,
  /** actions that must NOT carry a target (scroll uses direction; kb none) */
  noTarget: ['scroll', 'keyboardDismiss'] as const,
  /** coordinate form is target:{x,y} — never bare x/y at the top level */
  forbiddenTopLevel: ['x', 'y'] as const,
} as const;

interface ActPayload {
  udid?: string;
  action?: string;
  target?: unknown;
  text?: unknown;
  direction?: unknown;
  settle?: unknown;
  [k: string]: unknown;
}

function assertMirror(p: ActPayload, ctx: string): void {
  expect(typeof p.action, `${ctx}: action missing`).toBe('string');
  expect(MIRRORED_ACT_CONTRACT.actions, `${ctx}: unknown action ${p.action}`).toContain(p.action);
  for (const bad of MIRRORED_ACT_CONTRACT.forbiddenTopLevel) {
    expect(p[bad], `${ctx}: bare ${bad} at top level — use target:{x,y}`).toBeUndefined();
  }
  const needsTarget = !(MIRRORED_ACT_CONTRACT.noTarget as readonly string[]).includes(p.action!);
  if (needsTarget) expect(p.target, `${ctx}: ${p.action} requires target`).toBeDefined();
  if (p.action === 'fill') expect(typeof p.text, `${ctx}: fill requires text`).toBe('string');
  if (p.action === 'scroll') expect(p.direction, `${ctx}: scroll requires direction`).toBeDefined();
  if (p.target && typeof p.target === 'object') {
    const t = p.target as { x?: unknown; y?: unknown };
    expect(typeof t.x, `${ctx}: target.x must be number`).toBe('number');
    expect(typeof t.y, `${ctx}: target.y must be number`).toBe('number');
  }
}

/** load the LIVE alloy_act schema from the sibling repo when it exists */
function loadLiveSchema(): { parse: (input: unknown) => unknown } | null {
  const sibling = new URL('../../../../alloy/dist/index.js', import.meta.url);
  if (!existsSync(sibling)) return null;
  // a broken load must surface, not silently degrade to mirror-only
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const alloy = require(sibling.pathname) as { routingTable?: Array<{ tool: string; schema: { parse: (i: unknown) => unknown } }> };
  const row = alloy.routingTable?.find((r) => r.tool === 'alloy_act');
  if (!row) throw new Error('alloy sibling dist present but alloy_act row missing — contract test needs attention');
  return row.schema;
}

let db: Database.Database;
let tmp: string;
let captured: Array<{ tool: string; input: ActPayload }>;
let liveSchema: { parse: (input: unknown) => unknown } | null = null;

/** account screen (logged-in): tab bar + logout button + confirm sheet after tap */
function accountNodes(state: 'account' | 'sheet' | 'home') {
  const base = [
    { index: 0, parentIndex: -1, type: 'Application', label: 'App', rect: { x: 0, y: 0, width: 428, height: 926 }, hittable: false, ref: 'root' },
    { index: 1, parentIndex: 0, type: 'Image', identifier: 'ic_tabbar_account_inactive', label: 'Account', rect: { x: 344, y: 838, width: 24, height: 24 }, hittable: true, ref: 't1' },
  ];
  if (state === 'account' || state === 'sheet') {
    base.push({ index: 2, parentIndex: 0, type: 'Button', identifier: 'account_logout_button', label: 'Log out', rect: { x: 60, y: 560, width: 300, height: 44 }, hittable: true, ref: 'b1' } as never);
  }
  if (state === 'sheet') {
    base.push({ index: 3, parentIndex: 0, type: 'Button', identifier: 'account_logout_confirm_button', label: 'Confirm', rect: { x: 60, y: 600, width: 300, height: 44 }, hittable: true, ref: 'b2' } as never);
  }
  return base;
}

function fakeAlloy(): AlloyExports {
  /** state machine: home → (via tap) → account → (logout tap) → sheet → (confirm) → logged-out home */
  let state: 'home' | 'account' | 'sheet' = 'account';
  return {
    dispatch: async (tool: string, input: ActPayload) => {
      if (tool === 'alloy_snapshot') {
        return { ok: true, result: { nodes: state === 'home' ? accountNodes('home') : accountNodes(state) } };
      }
      if (tool === 'alloy_screenshot') return { ok: true, result: { path: '/dev/null' } };
      if (tool === 'alloy_act') {
        captured.push({ tool, input });
        // drive the fake UI forward on the real logout sequence
        if (input?.action === 'press') {
          const t = input.target as { x: number; y: number } | undefined;
          // via = tab-bar press (center of the tab icon rect)
          const viaTap = t && t.x >= 340 && t.x <= 370 && t.y >= 840 && t.y <= 870;
          if (viaTap) state = 'account';
          else if (state === 'account') state = 'sheet';
          else if (state === 'sheet') state = 'home';
        }
        return { ok: true, result: {} };
      }
      return { ok: true, result: {} };
    },
  } as unknown as AlloyExports;
}

const bus = { emit: () => undefined } as never;

function seed(id: string, steps: unknown[]): void {
  db.prepare(`INSERT INTO templates(id, name, udid, steps_json, app_bundle_id, created_by, created_at, updated_at)
              VALUES (?, ?, 'sim', ?, NULL, 'qa', 0, 0)`).run(id, id, JSON.stringify(steps));
}

async function play(id: string): Promise<string> {
  const r = await runTemplatePlayback({ db, bus, dispatchDeps: null, artifactsDir: tmp, forgeState: { activeRunId: null }, awaitStreamLive: async () => undefined, listApps: async () => [] } as never, id, {});
  await r.done;
  return r.runId;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'actcontract-'));
  db = new Database(':memory:');
  migrateM1(db);
  captured = [];
  liveSchema = loadLiveSchema();
  process.env.CRUCIBLE_SETTLE_MS = '10';
  process.env.CRUCIBLE_SETTLE_POLL_MS = '5';
  process.env.CRUCIBLE_STEP_TIMEOUT_MS = '4000';
  __setAlloyForTest(fakeAlloy());
});
afterEach(() => {
  delete process.env.CRUCIBLE_SETTLE_MS;
  delete process.env.CRUCIBLE_SETTLE_POLL_MS;
  delete process.env.CRUCIBLE_STEP_TIMEOUT_MS;
  rmSync(tmp, { recursive: true, force: true });
});

describe('alloy_act payload contract (ensure-logout real path)', () => {
  it('logged-in logout: every captured act payload satisfies the alloy_act contract (mirror + live schema when present)', async () => {
    seed('tpl_logout_contract', [
      { idx: 0, action: 'ensureLogout', ensureLogout: { button: 'account_logout_button', stay: 'account_logout_stay_button', confirm: 'account_logout_confirm_button', via: 'ic_tabbar_account_inactive' } },
    ]);
    const runId = await play('tpl_logout_contract');
    const status = (db.prepare('SELECT status FROM runs WHERE id=?').get(runId) as { status: string }).status;
    const step = db.prepare(`SELECT status, reason FROM run_steps WHERE run_id=? AND idx=0`).get(runId) as { status: string; reason: string | null };
    // the REAL logout path must have executed (not the shortcut)
    expect(`${step.status}: ${step.reason ?? ''}`, 'ensure-logout step').toContain('pass: session logged out');
    expect(status, `run status (step: ${step.reason})`).toBe('passed');
    // at least: via press + logout press + confirm press
    const acts = captured.filter((c) => c.tool === 'alloy_act');
    expect(acts.length).toBeGreaterThanOrEqual(3);
    for (const { input, tool } of acts) {
      assertMirror(input, `${tool} #${acts.indexOf({ tool, input })}`);
      const schema = liveSchema; // narrow once for the closure
      if (schema) {
        expect(() => schema.parse(input), `live alloy schema rejected: ${JSON.stringify(input)}`).not.toThrow();
      }
    }
  });

  it('logged-out shortcut emits NO act payloads (preflight only)', async () => {
    // state machine starts 'account' with the button visible — for the
    // shortcut case we want it invisible: use a template whose button never
    // resolves (guest account page) → preflight passes, zero acts
    seed('tpl_logout_shortcut', [
      { idx: 0, action: 'ensureLogout', ensureLogout: { button: 'account_logout_button', stay: '', confirm: 'account_logout_confirm_button' } },
    ]);
    // fake starts with the button PRESENT (logged in) — override to absent:
    // simplest honest shape: run with a fake whose snapshots never show the button
    __setAlloyForTest(((): AlloyExports => {
      return {
        dispatch: async (tool: string, input: ActPayload) => {
          if (tool === 'alloy_snapshot') return { ok: true, result: { nodes: accountNodes('home') } };
          if (tool === 'alloy_screenshot') return { ok: true, result: { path: '/dev/null' } };
          if (tool === 'alloy_act') { captured.push({ tool, input }); return { ok: true, result: {} }; }
          return { ok: true, result: {} };
        },
      } as unknown as AlloyExports;
    })());
    const runId = await play('tpl_logout_shortcut');
    const step = db.prepare(`SELECT status, reason FROM run_steps WHERE run_id=? AND idx=0`).get(runId) as { status: string; reason: string | null };
    expect(step.status).toBe('pass');
    expect(step.reason).toContain('already logged out');
    expect(captured.filter((c) => c.tool === 'alloy_act').length).toBe(0);
  });
});
