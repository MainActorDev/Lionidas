/** Inspect-mode tree lifecycle: fetch /tree, keep it aligned to the live
 *  screen via the stream's change-gated frames (SettleDetector), and never
 *  show boxes that don't match reality. States:
 *    off        — inspect disabled; no fetches, no data
 *    fetching   — first fetch after enable (no boxes to show yet)
 *    aligned    — tree matches the settled screen (boxes visible)
 *    realigning — screen changed (scroll/tap-this/lazy load): boxes hidden
 *    failed     — fetch failed; manual retry available
 *  The overlay renders boxes ONLY in `aligned` — drifting ghost boxes are
 *  a correctness bug, not a cosmetic one. */
import { ref, type Ref } from 'vue';
import type { AxNode } from '@crucible/shared/ax-tree';
import { SettleDetector } from '@crucible/shared/frame-settle';

export type TreeState = 'off' | 'fetching' | 'aligned' | 'realigning' | 'failed';

export interface InspectTree {
  state: Ref<TreeState>;
  /** last fetch failure — inspect .status/.code (TreeFetchError) to decide
   *  retryable vs session-dead before showing a message */
  lastError: Ref<Error | null>;
  /** true when aligned on a screen that never goes still (carousel/banner
   *  cross-fades): the tree was captured at one instant and a minority of
   *  nodes (the animating region) may drift. Labeled on the pill — honest. */
  animating: Ref<boolean>;
  nodes: Ref<AxNode[]>;
  logicalW: Ref<number | null>;
  logicalH: Ref<number | null>;
  /** enable/disable the lifecycle (mode toggle from the page) */
  enable(sessionId: string): void;
  disable(): void;
  /** stream-frame feed — call for every decoded frame paint */
  feedFrame(paintedAt: number): void;
  /** call ~1/s while enabled (drives quiet detection without frames) */
  tick(now: number): void;
  /** manual refetch (refresh button / after fetch failure) */
  refresh(): void;
  /** DOM scroll dispatched on the canvas — realign expected */
  markScroll(): void;
  /** explicit tap-this dispatch — realign expected */
  markInteraction(): void;
}

/** Fetch errors may carry status/code from the API (e.g. 410 SESSION_NOT_FOUND);
 *  the host page reads them to distinguish "engine hiccup" (retryable) from
 *  "session is dead" (must re-take control — retrying can never succeed). */
export class TreeFetchError extends Error {
  status?: number | undefined;
  code?: string | undefined;
  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function useInspectTree(fetchTree: (sessionId: string, signal: AbortSignal) => Promise<{ nodes: AxNode[]; logicalW: number | null; logicalH: number | null }>): InspectTree {
  const state = ref<TreeState>('off');
  const animating = ref(false);
  const lastError = ref<Error | null>(null);
  const nodes = ref<AxNode[]>([]);
  const logicalW = ref<number | null>(null);
  const logicalH = ref<number | null>(null);

  let sessionId: string | null = null;
  let version = 0;            // discards stale responses
  let inFlight: AbortController | null = null;
  let detector = new SettleDetector();
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  let lastFetchAt = 0;
  let busyCompletes = 0;      // consecutive fetches that landed while busy
  const REFETCH_COOLDOWN_MS = 2000; // carousel screens: burst-settle-burst forever —
                                    // cap the refetch cadence or we hammer /tree ~1/s
  const FORCE_ALIGN_AFTER = 3;      // never-quiet screens (banner cross-fade):
                                    // align anyway and label it `animating`

  async function doFetch(force = false): Promise<void> {
    if (!sessionId) return;
    if (!force && Date.now() - lastFetchAt < REFETCH_COOLDOWN_MS) {
      scheduleRefetch(REFETCH_COOLDOWN_MS - (Date.now() - lastFetchAt) + 50);
      return;
    }
    lastFetchAt = Date.now();
    const v = ++version;
    inFlight?.abort();
    const ac = new AbortController();
    inFlight = ac;
    if (state.value !== 'realigning') state.value = nodes.value.length ? 'realigning' : 'fetching';
    try {
      const r = await fetchTree(sessionId, ac.signal);
      if (v !== version) return; // a newer fetch (or disable) superseded this
      nodes.value = r.nodes;
      logicalW.value = r.logicalW;
      logicalH.value = r.logicalH;
      // QUIET-AT-COMPLETION gate: a fetch that lands mid-animation (carousel
      // auto-advance, skeleton shimmer) must NOT flash boxes that are already
      // stale. Only claim aligned when the screen is actually still (or the
      // user forced a refresh — their call, manual override of the honesty rule).
      const quiet = detector.tick(Date.now()) === 'quiet';
      if (force || quiet) {
        state.value = 'aligned';
        animating.value = false; // genuinely still (or fresh manual refresh);
        detector = new SettleDetector(); // aligned tree is fresh; restart detection
      } else if (++busyCompletes >= FORCE_ALIGN_AFTER) {
        // 3 fetches landed mid-animation: the screen never stills. Align anyway —
        // static elements (the vast majority) are accurate at this instant — but
        // LABEL it: the animating region's nodes may drift until the next refresh.
        state.value = 'aligned';
        animating.value = true;
        busyCompletes = 0;
        detector = new SettleDetector();
      } else {
        state.value = 'realigning';
        // A fetch that landed busy must actually re-arm — only tick()→quiet or
        // enable() can otherwise start one, so a never-quiet stream (idle-pump
        // frames every 1/fps, video playback) deadlocks here after ONE fetch.
        scheduleRefetch(REFETCH_COOLDOWN_MS + 50);
      }
    } catch (e) {
      if (ac.signal.aborted || v !== version) return;
      state.value = 'failed';
      lastError.value = e instanceof Error ? e : new Error(String(e));
    }
  }

  function scheduleRefetch(delay = 150): void {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => { void doFetch(); }, delay); // debounce bursts
  }

  return {
    state, animating, lastError, nodes, logicalW, logicalH,
    enable(sid: string): void {
      sessionId = sid;
      busyCompletes = 0;
      animating.value = false;
      state.value = 'fetching';
      nodes.value = [];
      void doFetch();
    },
    disable(): void {
      version++;
      inFlight?.abort();
      if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
      sessionId = null;
      state.value = 'off';
      nodes.value = [];
    },
    feedFrame(paintedAt: number): void {
      if (state.value === 'off' || state.value === 'failed') return;
      const s = detector.push(paintedAt);
      if (s === 'busy') {
        // screen is moving — boxes no longer provably match reality.
        // EXCEPT while labeled animating (never-quiet screen): that label IS
        // the honesty; demoting every frame would flap aligned↔realigning
        // forever and boxes would never render.
        if (state.value === 'aligned' && !animating.value) state.value = 'realigning';
      }
    },
    tick(now: number): void {
      if (state.value !== 'realigning') return;
      const s = detector.tick(now);
      if (s === 'quiet') scheduleRefetch();
    },
    refresh(): void { void doFetch(true); }, // force: bypass cooldown + quiet gate
    markScroll(): void {
      // A scroll is a REAL interaction, not frame noise: demote even when
      // labeled animating (the sticky label exists to ride out background
      // animation, not to survive a scroll), reset the busy-strike count,
      // and arm the settle loop so the refetch actually happens.
      detector = new SettleDetector();
      busyCompletes = 0;
      animating.value = false;
      if (state.value === 'aligned' || state.value === 'realigning') {
        state.value = 'realigning';
        scheduleRefetch();
      }
    },
    markInteraction(): void {
      // tap-this/keyboard: same as scroll — an interaction invalidates the
      // tree regardless of the animating label, and must re-arm a refetch.
      detector = new SettleDetector();
      busyCompletes = 0;
      animating.value = false;
      if (state.value === 'aligned' || state.value === 'realigning') {
        state.value = 'realigning';
        scheduleRefetch();
      }
    },
  };
}
