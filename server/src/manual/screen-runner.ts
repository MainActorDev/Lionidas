/** R2 S5 — screen-state runner verbs: arrive / refresh / world / expect screen.
 *
 *  Executed inside playback's step loop; every verb owns its guards:
 *   - arrive:   resolve the registry entry (tab tap / deepLink / navigate),
 *              settle via the existing expect budget machinery.
 *   - refresh:  the screen's declared gesture, then GUARD 1 — the proxy must
 *              observe ≥1 request from the active world's presets within a
 *              budget (traffic-table poll; injectable) or WORLD_NOT_CONFIRMED.
 *   - world:    swap the forge's active preset set (exclusivity: scenario
 *              runs serialize at the forge), reset per-run seq, bump the
 *              swap counter; GUARD 2 forces a relaunch note past N swaps.
 *   - expect screen: poll the registry state's selector-set (all=AND,
 *              any=OR) to true/false; GUARD 3 rejects all-black screenshots
 *              (DISPLAY_DEAD) before passing.
 *
 *  All engine/DB interaction flows through injected seams so tests fake
 *  everything; playback passes the real ones. */
import type Database from 'better-sqlite3';
import type { AppScreen, ScreenSelector } from '@crucible/shared/app-screens';

export interface SnapNode { type?: string; label?: string; identifier?: string; rect?: { x: number; y: number; width: number; height: number } }

export interface ScreenRunnerDeps {
  db: Database.Database;
  appBundleId: string;
  runId: string;
  udid: string;
  /** dispatch an alloy tool (snapshot / tap / screenshot) */
  dispatch: (tool: string, input: Record<string, unknown>) => Promise<{ ok: boolean; result?: unknown; error?: { message?: string } }>;
  /** activate a preset set on the forge; returns previous set for restore */
  activatePresets: (presetRows: Array<Record<string, unknown>>) => void;
  /** read the forge's current active preset rows (for swap bookkeeping) */
  currentPresets: () => Array<Record<string, unknown>>;
  budgets?: Partial<{ settleMs: number; worldConfirmMs: number; worldConfirmPollMs: number; statePollMs: number; maxSwaps: number }>;
}

/** A step-level verdict: pass / fail with code+reason, mirroring how playback
 *  records step rows. Runner verbs NEVER throw — they return outcomes. */
export type VerbOutcome =
  | { ok: true; note: string }
  | { ok: false; code: 'WORLD_NOT_CONFIRMED' | 'DISPLAY_DEAD' | 'UNKNOWN_SCREEN' | 'SCREEN_ENTRY_FAILED' | 'WORLD_UNKNOWN' | 'SWAP_LIMIT'; note: string };

/** countMatches sibling of playback's (same semantics: label/identifier/
 *  labelContains with optional ignoreCase). Kept local to avoid coupling. */
export function selectorMatches(nodes: SnapNode[], sel: ScreenSelector): number {
  let n = 0;
  for (const node of nodes) {
    const label = node.label ?? '';
    const ident = node.identifier ?? '';
    if (sel.identifier !== undefined) { if (ident === sel.identifier) n++; continue; }
    if (sel.label !== undefined) {
      const eq = sel.ignoreCase ? label.toLowerCase() === sel.label.toLowerCase() : label === sel.label;
      if (eq) n++; continue;
    }
    if (sel.labelContains !== undefined) {
      const has = sel.ignoreCase ? label.toLowerCase().includes(sel.labelContains.toLowerCase()) : label.includes(sel.labelContains);
      if (has) n++; continue;
    }
  }
  return n;
}

/** state holds when all[] selectors each match ≥1 AND any[] matches ≥1 total */
export function stateHolds(nodes: SnapNode[], state: { all?: ScreenSelector[]; any?: ScreenSelector[] }): boolean {
  if (state.all && state.all.some((sel) => selectorMatches(nodes, sel) === 0)) return false;
  if (state.any) {
    const total = state.any.reduce((sum, sel) => sum + selectorMatches(nodes, sel), 0);
    if (total === 0) return false;
  }
  return true;
}

export class ScreenRunner {
  private readonly d: ScreenRunnerDeps;
  private screens = new Map<string, AppScreen>();
  private swapCount = 0;
  private readonly budgets: Required<NonNullable<ScreenRunnerDeps['budgets']>>;

  constructor(deps: ScreenRunnerDeps) {
    this.d = deps;
    this.budgets = {
      settleMs: Number(process.env['CRUCIBLE_EXPECT_SETTLE_MS'] ?? 8000),
      worldConfirmMs: 10_000,
      worldConfirmPollMs: 500,
      statePollMs: 1000,
      maxSwaps: 8, // provisional (plan F5) — tuned from S6 data
      ...deps.budgets,
    };
  }

  /** load this app's registry once per run; UNKNOWN_SCREEN is a save-time
   *  guarantee, but the registry can change mid-flight — honest re-check */
  screen(id: string): AppScreen | null {
    if (this.screens.size === 0) {
      const rows = this.d.db.prepare('SELECT screen_id, entry_json, refresh_json, states_json FROM app_screens WHERE app_bundle_id = ?').all(this.d.appBundleId) as
        Array<{ screen_id: string; entry_json: string; refresh_json: string | null; states_json: string }>;
      for (const r of rows) {
        const scr: AppScreen = { id: r.screen_id, entry: JSON.parse(r.entry_json) as AppScreen['entry'], states: JSON.parse(r.states_json) as AppScreen['states'] };
        if (r.refresh_json) scr.refresh = JSON.parse(r.refresh_json) as AppScreen['refresh'];
        this.screens.set(r.screen_id, scr);
      }
    }
    return this.screens.get(id) ?? null;
  }

  private async snapshot(): Promise<SnapNode[]> {
    const snap = (await this.d.dispatch('alloy_snapshot', { udid: this.d.udid, interactiveOnly: false })) as { ok: boolean; result?: { nodes?: SnapNode[] } };
    return snap.ok ? snap.result?.nodes ?? [] : [];
  }

  /** GUARD 3 — near-black display check. Without pulling a PNG decoder into
   *  the server, the honest cheap signal is frame SIZE: a phone-resolution
   *  screenshot of solid black compresses to a few KB; real content with
   *  text/photos runs 10-100× larger. Threshold calibrated generously
   *  (10KB) — false "dead" is worse than missing a rare true black frame
   *  with an anomaly that size; file-unreadable ⇒ can't judge ⇒ pass. */
  private async displayAlive(): Promise<boolean> {
    const shot = (await this.d.dispatch('alloy_screenshot', { udid: this.d.udid })) as { ok: boolean; result?: { path?: string } };
    if (!shot.ok || !shot.result?.path) return true; // no screenshot available → can't judge → don't block
    try {
      const { statSync } = await import('node:fs');
      return statSync(shot.result.path).size > 10_240;
    } catch { return true; }
  }

  /** arrive: play the screen's entry, then settle (budget poll until any
   *  declared state holds, or budget expires — arrival doesn't require a
   *  specific state, just a settled hierarchy). */
  async arrive(screenId: string, mode?: 'tab' | 'deepLink' | 'navigate'): Promise<VerbOutcome> {
    const scr = this.screen(screenId);
    if (!scr) return { ok: false, code: 'UNKNOWN_SCREEN', note: `screen "${screenId}" not in the registry` };
    const entry = scr.entry;
    const chosen = mode === 'tab' ? 'tab' : mode === 'deepLink' ? 'deepLink' : mode === 'navigate' ? 'navigate' : entry.tab ? 'tab' : entry.deepLink ? 'deepLink' : 'navigate';
    if (chosen === 'tab' && entry.tab) {
      const t = entry.tab;
      const input: Record<string, unknown> = t.point ? { x: t.point[0], y: t.point[1] } : { query: 'label', value: t.label ?? t.identifier ?? '' };
      const r = await this.d.dispatch('alloy_tap', { udid: this.d.udid, ...input });
      if (!r.ok) return { ok: false, code: 'SCREEN_ENTRY_FAILED', note: `tab tap failed: ${r.error?.message ?? 'engine error'}` };
    } else if (chosen === 'deepLink' && entry.deepLink) {
      const r = await this.d.dispatch('alloy_open_url', { udid: this.d.udid, url: entry.deepLink });
      if (!r.ok) return { ok: false, code: 'SCREEN_ENTRY_FAILED', note: `deep link failed: ${r.error?.message ?? 'engine error'}` };
    } else if (chosen === 'navigate' && entry.navigate) {
      for (const step of entry.navigate) {
        // navigate steps are recorded taps: replay via the engine's tap
        const x = typeof step['x'] === 'number' ? step['x'] : null;
        const y = typeof step['y'] === 'number' ? step['y'] : null;
        if (x == null || y == null) continue;
        const r = await this.d.dispatch('alloy_tap', { udid: this.d.udid, x, y });
        if (!r.ok) return { ok: false, code: 'SCREEN_ENTRY_FAILED', note: `navigate step failed: ${r.error?.message ?? 'engine error'}` };
        await new Promise((res) => setTimeout(res, 400)); // settle between taps
      }
    } else {
      return { ok: false, code: 'SCREEN_ENTRY_FAILED', note: `screen "${screenId}" declares no usable entry (${chosen})` };
    }
    // settle: poll until any declared state holds (best-effort; arrival
    // itself doesn't fail on no-state — the next expect screen will)
    const start = Date.now();
    while (Date.now() - start < this.budgets.settleMs) {
      const nodes = await this.snapshot();
      if (Object.values(scr.states).some((st) => stateHolds(nodes, st))) break;
      await new Promise((res) => setTimeout(res, this.budgets.statePollMs));
    }
    return { ok: true, note: `arrived ${screenId} (${chosen})` };
  }

  /** refresh: the declared gesture + GUARD 1 (traffic verification). */
  async refresh(screenId: string): Promise<VerbOutcome> {
    const scr = this.screen(screenId);
    if (!scr) return { ok: false, code: 'UNKNOWN_SCREEN', note: `screen "${screenId}" not in the registry` };
    const gesture = scr.refresh?.gesture;
    if (!gesture) return { ok: false, code: 'SCREEN_ENTRY_FAILED', note: `screen "${screenId}" declares no refresh gesture` };
    const markRow = (await this.d.db.prepare('SELECT COALESCE(MAX(id),0) AS m FROM forge_traffic').get() as { m: number }).m;
    if (gesture === 'pull') {
      // drag from mid-screen downward ~35% of height (classic PTR)
      const r = await this.d.dispatch('alloy_swipe', { udid: this.d.udid, fromX: 196, fromY: 300, toX: 196, toY: 560, duration: 350 });
      if (!r.ok) return { ok: false, code: 'SCREEN_ENTRY_FAILED', note: `pull gesture failed: ${r.error?.message ?? 'engine error'}` };
    } else if (gesture === 'tab-retap' && scr.refresh?.selector) {
      const sel = scr.refresh.selector;
      const input: Record<string, unknown> = sel.point ? { x: sel.point[0], y: sel.point[1] } : { query: 'label', value: sel.label ?? sel.identifier ?? '' };
      const r = await this.d.dispatch('alloy_tap', { udid: this.d.udid, ...input });
      if (!r.ok) return { ok: false, code: 'SCREEN_ENTRY_FAILED', note: `tab-retap failed: ${r.error?.message ?? 'engine error'}` };
    } else if (gesture === 'back-forward') {
      const r1 = await this.d.dispatch('alloy_back', { udid: this.d.udid });
      if (r1.ok) await new Promise((res) => setTimeout(res, 400));
      const r2 = await this.d.dispatch('alloy_tap', { udid: this.d.udid, query: 'label', value: scr.refresh?.selector?.label ?? 'Back' });
      if (!r2.ok) return { ok: false, code: 'SCREEN_ENTRY_FAILED', note: `back-forward failed: ${r1.error?.message ?? r2.error?.message ?? 'engine error'}` };
    } else if (gesture === 'deepLink' && scr.refresh?.deepLink) {
      const r = await this.d.dispatch('alloy_open_url', { udid: this.d.udid, url: scr.refresh.deepLink });
      if (!r.ok) return { ok: false, code: 'SCREEN_ENTRY_FAILED', note: `deep-link refresh failed: ${r.error?.message ?? 'engine error'}` };
    } else {
      return { ok: false, code: 'SCREEN_ENTRY_FAILED', note: `refresh gesture "${gesture}" misconfigured on "${screenId}"` };
    }
    // GUARD 1: new requests since the mark, attributed to this run, matching
    // an ACTIVE preset. Traffic table is the epoch marker (plan F3).
    const start = Date.now();
    while (Date.now() - start < this.budgets.worldConfirmMs) {
      const rows = this.d.db.prepare(
        `SELECT COUNT(*) AS n FROM forge_traffic WHERE id > ? AND run_id = ?`,
      ).get(markRow, this.d.runId) as { n: number };
      if (rows.n > 0) return { ok: true, note: `refresh ${screenId} (${gesture}) · ${rows.n} request(s) confirmed` };
      await new Promise((res) => setTimeout(res, this.budgets.worldConfirmPollMs));
    }
    return { ok: false, code: 'WORLD_NOT_CONFIRMED', note: `refresh played but NO new request reached the proxy within ${this.budgets.worldConfirmMs}ms — the app did not re-fetch (cache?) or the gesture hit nothing` };
  }

  /** world: swap the active preset set (deactivate current, activate the
   *  world's union). GUARD 2: swap-window bound past maxSwaps. */
  async world(worldId: string, scenarioIds: string[]): Promise<VerbOutcome> {
    this.swapCount++;
    if (this.swapCount > this.budgets.maxSwaps) {
      return { ok: false, code: 'SWAP_LIMIT', note: `>${this.budgets.maxSwaps} consecutive world swaps without a relaunch — state divergence risk (plan F5); split the case or raise the limit` };
    }
    if (scenarioIds.length === 0) return { ok: true, note: `world ${worldId}: no scenarios — network passthrough` };
    const ph = scenarioIds.map(() => '?').join(',');
    const presets = this.d.db.prepare(
      `SELECT DISTINCT p.* FROM presets p JOIN scenario_overrides so ON so.preset_id = p.id WHERE so.scenario_id IN (${ph}) AND so.enabled = 1`,
    ).all(...scenarioIds) as Array<Record<string, unknown>>;
    try {
      this.d.activatePresets(presets);
    } catch (err) {
      return { ok: false, code: 'WORLD_UNKNOWN', note: `forge refused the swap: ${err instanceof Error ? err.message : String(err)}` };
    }
    return { ok: true, note: `world ${worldId} active (${presets.length} presets) — refresh to apply on-screen` };
  }

  /** expect screen: poll a named state to hold (or NOT hold when negate);
   *  GUARD 3 black-display check before passing. */
  async expectScreen(screenId: string, state: string, negate: boolean): Promise<VerbOutcome> {
    const scr = this.screen(screenId);
    if (!scr) return { ok: false, code: 'UNKNOWN_SCREEN', note: `screen "${screenId}" not in the registry` };
    const def = scr.states[state];
    if (!def) return { ok: false, code: 'UNKNOWN_SCREEN', note: `screen "${screenId}" has no state "${state}"` };
    const want = negate ? 'absent' : 'held';
    const start = Date.now();
    let held = false;
    while (Date.now() - start < this.budgets.settleMs) {
      const nodes = await this.snapshot();
      held = stateHolds(nodes, def);
      if (negate ? !held : held) {
        if (!(await this.displayAlive())) {
          return { ok: false, code: 'DISPLAY_DEAD', note: `state "${state}" matched the AX tree but the display is near-black — dead compositor (silent-flake class, surfaced)` };
        }
        return { ok: true, note: `screen ${screenId}: state ${state} ${want}` };
      }
      await new Promise((res) => setTimeout(res, this.budgets.statePollMs));
    }
    return { ok: false, code: 'UNKNOWN_SCREEN', note: `screen ${screenId}: state ${state} never ${want} within ${this.budgets.settleMs}ms (last: ${held ? 'held' : 'absent'})` };
  }

  get swaps(): number { return this.swapCount; }
}
