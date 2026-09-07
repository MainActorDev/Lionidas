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

export function useInspectTree(fetchTree: (sessionId: string, signal: AbortSignal) => Promise<{ nodes: AxNode[]; logicalW: number | null; logicalH: number | null }>): InspectTree {
  const state = ref<TreeState>('off');
  const nodes = ref<AxNode[]>([]);
  const logicalW = ref<number | null>(null);
  const logicalH = ref<number | null>(null);

  let sessionId: string | null = null;
  let version = 0;            // discards stale responses
  let inFlight: AbortController | null = null;
  let detector = new SettleDetector();
  let settleTimer: ReturnType<typeof setTimeout> | null = null;

  async function doFetch(): Promise<void> {
    if (!sessionId) return;
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
      state.value = 'aligned';
      detector = new SettleDetector(); // aligned tree is fresh; restart detection
    } catch (e) {
      if (ac.signal.aborted || v !== version) return;
      state.value = 'failed';
    }
  }

  function scheduleRefetch(): void {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => { void doFetch(); }, 150); // debounce bursts
  }

  return {
    state, nodes, logicalW, logicalH,
    enable(sid: string): void {
      sessionId = sid;
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
        // screen is moving — boxes no longer provably match reality
        if (state.value === 'aligned') state.value = 'realigning';
      }
    },
    tick(now: number): void {
      if (state.value !== 'realigning') return;
      const s = detector.tick(now);
      if (s === 'quiet') scheduleRefetch();
    },
    refresh(): void { void doFetch(); },
    markScroll(): void {
      detector = new SettleDetector();
      if (state.value === 'aligned') state.value = 'realigning';
    },
    markInteraction(): void {
      detector = new SettleDetector();
      if (state.value === 'aligned') state.value = 'realigning';
    },
  };
}
