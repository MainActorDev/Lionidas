/** Typed pub/sub event bus. The taxonomy grows per phase; the impl never changes. */
export type AppEvents = {
  'app.ready': { version: string };
  'device.changed': { udid: string; name: string | null; state: string | null; platform?: string | null; kind?: string | null; lease_holder: string | null; lease_engine: string | null };
  'run.started': { runId: string; ticketKey: string };
  'run.freshness.checked': { runId: string; freshness: string };
  'step.started': { runId: string; idx: number; flow: string; name: string };
  'step.finished': { runId: string; idx: number; flow: string; name: string; status: string; durationMs: number };
  /** readiness phases before the first step — the panel shows them as the
   *  gate (stream → app → steps); phase 'steps' == run.plan follows */
  'run.phase': { runId: string; phase: 'stream' | 'app' | 'steps' };
  /** run plan (A6 run panel): the expanded step list a run will execute —
   *  subflows flattened + reindexed, exactly as run_steps will be written.
   *  Emitted once, right after run.started. */
  'run.plan': { runId: string; templateId: string; udid: string; steps: Array<{ idx: number; action: string; name: string; flow: string | null; optional: boolean }> };
  'run.finished': { runId: string; status: string };
  'run.aborted': { queueId: string };
  'queue.changed': { queueId: string; state: string };
  'forge.traffic.hit': { id: string; runId: string | null; method: string; path: string; status: number; latencyMs: number; mode: string; matchedPresetId: string | null };
  'baseline.diff.pending': { diffId: string; scopeKey: string; runId: string };
  'baseline.diff.decided': { diffId: string; state: string; scopeKey: string };
  'manual.session.open': { sessionId: string; udid: string; operator: string; runId: string };
  'manual.session.tap': { sessionId: string; x: number; y: number };
  'manual.session.scroll': { sessionId: string; direction: string };
  'manual.session.snapshot': { sessionId: string; path: string };
  'manual.session.type': { sessionId: string; x: number; y: number; len: number };
  'manual.session.recording': { sessionId: string; on: boolean };
  'manual.session.step': { sessionId: string; step: { idx: number; action: string; thumb: string | null } };
  'manual.session.finish': { sessionId: string };
  'flow.quarantined': { flowKey: string; reason: string };
} & Record<string, unknown>;

export interface TypedEventBus<E extends Record<string, unknown>> {
  emit<K extends keyof E & string>(type: K, payload: E[K]): void;
  on<K extends keyof E & string>(type: K, fn: (p: E[K]) => void): () => void;
}

export function createEventBus<E extends Record<string, unknown>>(): TypedEventBus<E> {
  const listeners = new Map<keyof E & string, Set<(p: never) => void>>();
  return {
    emit(type, payload) {
      const set = listeners.get(type);
      if (!set) return;
      for (const fn of set) (fn as (p: unknown) => void)(payload);
    },
    on(type, fn) {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(fn as (p: never) => void);
      return () => set.delete(fn as (p: never) => void);
    },
  };
}
