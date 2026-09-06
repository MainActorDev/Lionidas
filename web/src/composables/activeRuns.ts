/** Active-run tracker: the ONE source of truth for "this case is running
 *  right now", shared by the row (▶ → ■ abort) and the run panel (abort in
 *  header) — the interlock that keeps both surfaces honest across tabs,
 *  refreshes, and runs started elsewhere.
 *
 *  Seeded by fetch (page refresh mid-run, other-tab runs), then kept live
 *  by the shared /api/events WS window: run.started adds, run.finished /
 *  run.aborted removes, queue.changed triggers a reseed (queued rows may
 *  dispatch or vanish without per-template events). */
import { reactive, readonly } from 'vue';
import { useLiveEvents, type LiveEvent } from '../stores/live.ts';

export interface ActiveRun {
  runId: string;
  templateId: string | null;
  startedAt: number | null;
}

const state = reactive({
  runs: new Map<string, ActiveRun>(), // key: runId
  byTemplate: new Map<string, string>(), // templateId -> runId
});

let started = false;

function upsert(run: ActiveRun): void {
  state.runs.set(run.runId, run);
  if (run.templateId) state.byTemplate.set(run.templateId, run.runId);
}

function removeRun(runId: string): void {
  const run = state.runs.get(runId);
  state.runs.delete(runId);
  if (run?.templateId && state.byTemplate.get(run.templateId) === runId) {
    state.byTemplate.delete(run.templateId);
  }
}

/** Fetch all non-terminal runs once. `fetchFn` injectable for tests. */
export async function seedActiveRuns(fetchFn: typeof fetch = fetch): Promise<void> {
  try {
    const r = await fetchFn('/api/runs?status=running&limit=100');
    if (!r.ok) return;
    const b = (await r.json()) as { runs?: Array<{ id: string; template_id: string | null; started_at: number | null; status: string }> };
    for (const row of b.runs ?? []) {
      if (row.status !== 'running' && row.status !== 'queued') continue;
      upsert({ runId: row.id, templateId: row.template_id ?? null, startedAt: row.started_at ?? null });
    }
  } catch { /* offline server: rows stay empty; events will fill in */ }
}

function onEvent(ev: LiveEvent): void {
  const p = ev.payload as Record<string, unknown>;
  if (ev.type === 'run.started' && typeof p['runId'] === 'string') {
    upsert({
      runId: p['runId'],
      templateId: typeof p['templateId'] === 'string' ? p['templateId'] : null,
      startedAt: Date.now(),
    });
    return;
  }
  if (ev.type === 'run.finished' && typeof p['runId'] === 'string') {
    removeRun(p['runId']);
    return;
  }
  if (ev.type === 'run.aborted') {
    // click-time ack carries runId; queue-dispatch aborts carry queueId only
    const id = typeof p['runId'] === 'string' ? p['runId'] : (typeof p['queueId'] === 'string' ? p['queueId'] : null);
    if (id) removeRun(id);
    return;
  }
  if (ev.type === 'queue.changed') {
    // queued rows can dispatch (run.started follows) or be aborted — reseed
    void seedActiveRuns();
  }
}

/** Idempotent: starts seeding + WS subscription once per page. */
export function initActiveRuns(fetchFn: typeof fetch = fetch): void {
  if (started) return;
  started = true;
  void seedActiveRuns(fetchFn);
  const live = useLiveEvents();
  live.connect();
  // consume the shared rolling window from its END (we may mount late)
  let cursor = live.events.length;
  const tick = window.setInterval(() => {
    if (live.events.length < cursor) cursor = 0; // window rolled over
    for (; cursor < live.events.length; cursor++) onEvent(live.events[cursor]!);
  }, 250);
  // page lifetime — no teardown (same pattern as other singletons)
  void tick;
}

export function useActiveRuns(): {
  isRunning: (templateId: string) => boolean;
  activeRun: (templateId: string) => ActiveRun | null;
  all: () => ActiveRun[];
} {
  return {
    isRunning: (templateId: string) => state.byTemplate.has(templateId),
    activeRun: (templateId: string) => {
      const rid = state.byTemplate.get(templateId);
      return rid ? (state.runs.get(rid) ?? null) : null;
    },
    all: () => [...state.runs.values()],
  };
}

/** Test seams: reset singleton + drive an event directly. */
export function __resetActiveRunsForTest(): void {
  state.runs.clear();
  state.byTemplate.clear();
  started = false;
}
export function __onEventForTest(ev: LiveEvent): void { onEvent(ev); }
export function __seedForTest(rows: ActiveRun[]): void { for (const r of rows) upsert(r); }
