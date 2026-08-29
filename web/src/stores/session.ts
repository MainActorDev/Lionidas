import { defineStore } from 'pinia';

/** M0: server reachability. M1 grows this into WS connection state + live cache. */
export const useSessionStore = defineStore('session', {
  state: () => ({ serverOk: false as boolean | null }),
  actions: {
    async ping(): Promise<void> {
      try {
        const res = await fetch('/api/health');
        this.serverOk = res.ok;
      } catch {
        this.serverOk = false;
      }
    },
  },
});
