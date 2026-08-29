/** Typed pub/sub event bus. The taxonomy grows per phase; the impl never changes. */
export type AppEvents = {
  'app.ready': { version: string };
  'device.changed': { udid: string; name: string | null; state: string | null; lease_holder: string | null; lease_engine: string | null };
  'run.started': { runId: string; ticketKey: string };
  'run.freshness.checked': { runId: string; freshness: string };
  'step.started': { runId: string; idx: number; flow: string };
  'step.finished': { runId: string; idx: number; flow: string; status: string; durationMs: number };
  'run.finished': { runId: string; status: string };
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
