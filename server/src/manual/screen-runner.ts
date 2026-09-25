/** R2 S5 — screen-state runner verbs: arrive / refresh / swap / expect screen.
 *
 *  Executed inside playback's step loop; every verb owns its guards:
 *   - arrive:   resolve the registry entry (tab tap / deepLink / navigate),
 *              settle via the existing expect budget machinery.
 *   - refresh:  the screen's declared gesture, then GUARD 1 — the proxy must
 *              observe ≥1 request from the active swap target's presets within a
 *              budget (traffic-table poll; injectable) or SWAP_NOT_CONFIRMED.
 *   - swap:     replace the forge's active preset set (exclusivity: scenario
 *              runs serialize at the forge), reset per-run seq, bump the
 *              swap counter; GUARD 2 forces a relaunch note past N swaps.
 *   - expect screen: poll the registry state's selector-set (all=AND,
 *              any=OR) to true/false; GUARD 3 rejects all-black screenshots
 *              (DISPLAY_DEAD) before passing.
 *
 *  All engine/DB interaction flows through injected seams so tests fake
 *  everything; playback passes the real ones. */
import type Database from 'better-sqlite3';
import { stateHolds, type AppScreen, type ScreenSelector, type SnapNode } from '@crucible/shared/app-screens';


export interface ScreenRunnerDeps {
  db: Database.Database;
  appBundleId: string;
  runId: string;
  udid: string;
  /** dispatch an alloy tool (snapshot / tap / screenshot) */
  dispatch: (tool: string, input: Record<string, unknown>) => Promise<{ ok: boolean; result?: unknown; error?: { message?: string } }>;
  /** activate a preset set on the forge; returns previous set for restore */
  forgeActivate?: (presetRows: Array<Record<string, unknown>>) => void;
  /** read the forge's current active preset rows (for swap bookkeeping) */
  forgeActive?: () => Array<Record<string, unknown>>;
  budgets?: Partial<{ settleMs: number; worldConfirmMs: number; worldConfirmPollMs: number; statePollMs: number; maxSwaps: number }>;
}

/** A step-level verdict: pass / fail with code+reason, mirroring how playback
 *  records step rows. Runner verbs NEVER throw — they return outcomes. */
export type VerbOutcome =
  | { ok: true; note: string }
  | { ok: false; code: 'SWAP_NOT_CONFIRMED' | 'DISPLAY_DEAD' | 'UNKNOWN_SCREEN' | 'SCREEN_ENTRY_FAILED' | 'SWAP_UNKNOWN' | 'SWAP_LIMIT'; note: string };



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

  /** host-level deep link via apps.openSimulatorUrl (allowlisted module —
   *  device ops stay inside the known surface). No engine involvement. */
  /** post the Darwin refresh signal into the sim (device op in apps.ts) */
  private async postSignal(name: string, what: string): Promise<VerbOutcome | null> {
    try {
      const { postDarwinNotification } = await import('./apps.ts');
      await postDarwinNotification(this.d.udid, name);
      return null;
    } catch (err) {
      return { ok: false, code: 'SCREEN_ENTRY_FAILED', note: `${what} failed: ${err instanceof Error ? err.message : String(err)} (device spawn broken? reboot the sim)` };
    }
  }

  private async openUrl(url: string, what: string): Promise<VerbOutcome | null> {
    try {
      const { openSimulatorUrl } = await import('./apps.ts');
      await openSimulatorUrl(this.d.udid, url);
      return null;
    } catch (err) {
      return { ok: false, code: 'SCREEN_ENTRY_FAILED', note: `${what} failed: ${err instanceof Error ? err.message : String(err)}` };
    }
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

  private async act(input: Record<string, unknown>): Promise<{ ok: boolean; error?: { message?: string } }> {
    return this.d.dispatch('alloy_act', { udid: this.d.udid, ...input }) as Promise<{ ok: boolean; error?: { message?: string } }>;
  }

  /** resolve a selector against the live tree → centered point (house
   *  pattern from selector.ts; engine taps are coordinate-only). */
  private async tapAt(sel: ScreenSelector & { point?: [number, number] }, what: string): Promise<VerbOutcome | null> {
    if (sel.point) {
      const r = await this.act({ action: 'press', target: { x: sel.point[0], y: sel.point[1] }, settle: false });
      return r.ok ? null : { ok: false, code: 'SCREEN_ENTRY_FAILED', note: `${what} tap failed: ${r.error?.message ?? 'engine error'}` };
    }
    const nodes = await this.snapshot();
    const { resolveSelector } = await import('./selector.ts');
    const hit = resolveSelector(nodes as never, sel as never, 'recentre');
    if (!hit) return { ok: false, code: 'SCREEN_ENTRY_FAILED', note: `${what}: selector ${sel.label ?? sel.identifier ?? sel.labelContains ?? '(unspecified)'} not found in the live tree` };
    const r = await this.act({ action: 'press', target: { x: Math.round(hit.x), y: Math.round(hit.y) }, settle: false });
    return r.ok ? null : { ok: false, code: 'SCREEN_ENTRY_FAILED', note: `${what} tap failed: ${r.error?.message ?? 'engine error'}` };
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
      const fail = await this.tapAt(entry.tab, 'tab');
      if (fail) return fail;
    } else if (chosen === 'deepLink' && entry.deepLink) {
      const fail = await this.openUrl(entry.deepLink, 'deep link');
      if (fail) return fail;
    } else if (chosen === 'navigate' && entry.navigate) {
      for (const step of entry.navigate) {
        const x = typeof step['x'] === 'number' ? step['x'] : null;
        const y = typeof step['y'] === 'number' ? step['y'] : null;
        if (x == null || y == null) continue;
        const r = await this.act({ action: 'press', target: { x, y }, settle: false });
        if (!r.ok) return { ok: false, code: 'SCREEN_ENTRY_FAILED', note: `navigate step failed: ${r.error?.message ?? 'engine error'}` };
        await new Promise((res) => setTimeout(res, 400)); // settle between taps
      }
    } else {
      return { ok: false, code: 'SCREEN_ENTRY_FAILED', note: `screen "${screenId}" declares no usable entry (${chosen})` };
    }
    const fail = await this.arriveInternal(screenId);
    return fail ?? { ok: true, note: `arrived ${screenId} (${chosen})` };
  }

  /** poll until NO declared state holds — i.e. we provably LEFT the screen
   *  (covering screen presented). Bounded by settleMs; returns regardless
   *  (honest degrade — the return tap still gets its chance). */
  private async waitGone(screenId: string): Promise<void> {
    const scr = this.screen(screenId);
    if (!scr) return;
    const start = Date.now();
    while (Date.now() - start < this.budgets.settleMs) {
      const nodes = await this.snapshot();
      if (!Object.values(scr.states).some((st) => stateHolds(nodes, st))) return;
      await new Promise((res) => setTimeout(res, this.budgets.statePollMs));
    }
  }

  /** poll until a declared state holds again — the screen is VISIBLY back
   *  before the caller asserts world-specific states on it. */
  private async waitBack(screenId: string): Promise<void> {
    const scr = this.screen(screenId);
    if (!scr) return;
    const start = Date.now();
    while (Date.now() - start < this.budgets.settleMs) {
      const nodes = await this.snapshot();
      if (Object.values(scr.states).some((st) => stateHolds(nodes, st))) return;
      await new Promise((res) => setTimeout(res, this.budgets.statePollMs));
    }
  }

  /** settle: poll until any declared state holds (best-effort; arrival
   *  itself doesn't fail on no-state — the next expect screen will). */
  private async arriveInternal(screenId: string): Promise<VerbOutcome | null> {
    const scr = this.screen(screenId);
    if (!scr) return { ok: false, code: 'UNKNOWN_SCREEN', note: `screen "${screenId}" not in the registry` };
    const start = Date.now();
    while (Date.now() - start < this.budgets.settleMs) {
      const nodes = await this.snapshot();
      if (Object.values(scr.states).some((st) => stateHolds(nodes, st))) break;
      await new Promise((res) => setTimeout(res, this.budgets.statePollMs));
    }
    return null;
  }

  /** refresh: the declared gesture + GUARD 1 (traffic verification). */
  async refresh(screenId: string): Promise<VerbOutcome> {
    const scr = this.screen(screenId);
    if (!scr) return { ok: false, code: 'UNKNOWN_SCREEN', note: `screen "${screenId}" not in the registry` };
    const gesture = scr.refresh?.gesture;
    if (!gesture) return { ok: false, code: 'SCREEN_ENTRY_FAILED', note: `screen "${screenId}" declares no refresh gesture` };
    const markTs = Date.now(); // epoch marker: only requests AFTER the gesture count
    if (gesture === 'pull') {
      // classic PTR: content drag down re-triggers the fetch
      const r = await this.act({ action: 'scroll', direction: 'down' });
      if (!r.ok) return { ok: false, code: 'SCREEN_ENTRY_FAILED', note: `pull gesture failed: ${r.error?.message ?? 'engine error'}` };
    } else if (gesture === 'tab-retap' && scr.refresh?.selector) {
      const fail = await this.tapAt(scr.refresh.selector, 'tab-retap');
      if (fail) return fail;
    } else if (gesture === 'back-forward') {
      // real semantics: AWAY via the entry-side anchor (the thing that opens
      // the covering screen — e.g. "See all"), RETURN via the back anchor
      // (the pushed screen's back button; the tab bar is hidden there).
      // The round trip re-triggers the fetch; guard 1 verifies it did.
      // Settle by STATE TRANSITIONS, not fixed sleeps: a fixed 600ms between
      // legs taps mid push-animation and misses (proven live — the return
      // tap landed before the form finished presenting).
      if (!scr.refresh?.selector) return { ok: false, code: 'SCREEN_ENTRY_FAILED', note: `screen "${screenId}": back-forward needs an away anchor (refresh.selector)` };
      const away = await this.tapAt(scr.refresh.selector, 'back-forward away');
      if (away) return away;
      await this.waitGone(screenId); // poll until no declared state holds (we left)
      const ret = scr.refresh?.back
        ? await this.tapAt(scr.refresh.back, 'back-forward return')
        : await this.arriveInternal(screenId);
      if (ret) return ret;
      await this.waitBack(screenId); // poll until a declared state holds again
    } else if (gesture === 'signal') {
      // in-place refetch: the app's uitest seam listens for a Darwin
      // notification — no navigation, no relaunch. The device op lives in
      // apps.ts (the allowlisted module); this file only calls through.
      const fail = await this.postSignal(`com.crucible.refresh.${screenId}`, 'signal refresh');
      if (fail) return fail;
    } else if (gesture === 'deepLink' && scr.refresh?.deepLink) {
      const fail = await this.openUrl(scr.refresh.deepLink, 'deep-link refresh');
      if (fail) return fail;
    } else {
      return { ok: false, code: 'SCREEN_ENTRY_FAILED', note: `refresh gesture "${gesture}" misconfigured on "${screenId}"` };
    }
    // GUARD 1: new requests since the gesture, attributed to this run AND
    // answered by an ACTIVE preset (the swap's own presets) — the real
    // `traffic` table (TEXT ids, epoch ts; run attribution via setActiveRun).
    const start = Date.now();
    while (Date.now() - start < this.budgets.worldConfirmMs) {
      const rows = this.d.db.prepare(
        `SELECT COUNT(*) AS n FROM traffic WHERE ts > ? AND run_id = ? AND matched_preset_id IS NOT NULL`,
      ).get(markTs, this.d.runId) as { n: number };
      if (rows.n > 0) return { ok: true, note: `refresh ${screenId} (${gesture}) · ${rows.n} request(s) confirmed` };
      await new Promise((res) => setTimeout(res, this.budgets.worldConfirmPollMs));
    }
    return { ok: false, code: 'SWAP_NOT_CONFIRMED', note: `refresh played but NO preset-matched request reached the proxy within ${this.budgets.worldConfirmMs}ms — the app did not re-fetch (cache?) or the gesture hit nothing` };
  }

  /** world: swap the active preset set (deactivate current, activate the
   *  world's union). GUARD 2: swap-window bound past maxSwaps. */
  async swap(swapId: string, scenarioIds: string[]): Promise<VerbOutcome> {
    this.swapCount++;
    if (this.swapCount > this.budgets.maxSwaps) {
      return { ok: false, code: 'SWAP_LIMIT', note: `>${this.budgets.maxSwaps} consecutive swaps without a relaunch — state divergence risk (plan F5); split the case or raise the limit` };
    }
    if (scenarioIds.length === 0) return { ok: true, note: `swap ${swapId}: no scenarios — network passthrough` };
    const ph = scenarioIds.map(() => '?').join(',');
    const presets = this.d.db.prepare(
      `SELECT DISTINCT p.* FROM presets p JOIN scenario_overrides so ON so.preset_id = p.id WHERE so.scenario_id IN (${ph}) AND so.enabled = 1`,
    ).all(...scenarioIds) as Array<Record<string, unknown>>;
    try {
      this.d.forgeActivate?.(presets);
    } catch (err) {
      return { ok: false, code: 'SWAP_UNKNOWN', note: `forge refused the swap: ${err instanceof Error ? err.message : String(err)}` };
    }
    return { ok: true, note: `swap ${swapId} active (${presets.length} presets) — refresh to apply on-screen` };
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
