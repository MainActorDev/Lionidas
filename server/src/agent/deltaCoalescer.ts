/** Server-side delta coalescer (Phase 5 step 3, t3code ProviderTextDeltaCoalescer
 *  pattern): buffer per-(turn,item) text deltas and flush coalesced
 *  text-so-far snapshots on an interval — per-token frames never reach the WS.
 *
 *  Keyed by item id: the client applies a snapshot by REPLACING that item's
 *  text, so ordering across items is free and a late flush after turn end
 *  can't corrupt a completed item. flushTurn() drains everything on terminal
 *  events (with finalText override) so nothing is lost when the interval
 *  hasn't fired yet. */

export interface CoalescedSnapshot {
  kind: 'message_snapshot';
  sessionId: string;
  turnId: string;
  itemId: string;
  /** FULL text so far (not a delta) — idempotent client application. */
  text: string;
  done: boolean;
}

export interface DeltaCoalescerOptions {
  /** flush interval ms (default 80 — hypothesis from the plan, tunable). */
  intervalMs?: number;
  /** clock injectable for tests. */
  setIntervalFn?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (t: ReturnType<typeof setInterval>) => void;
}

interface BufferState {
  text: string;
  done: boolean;
}

export class DeltaCoalescer {
  private readonly buffers = new Map<string, BufferState>(); // key: sessionId|turnId|itemId
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly intervalMs: number;
  private readonly si: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  private readonly ci: (t: ReturnType<typeof setInterval>) => void;

  constructor(
    private readonly emit: (snap: CoalescedSnapshot) => void,
    opts: DeltaCoalescerOptions = {},
  ) {
    this.intervalMs = opts.intervalMs ?? 80;
    this.si = opts.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
    this.ci = opts.clearIntervalFn ?? ((t) => clearInterval(t));
  }

  private key(sessionId: string, turnId: string, itemId: string): string {
    return `${sessionId}|${turnId}|${itemId}`;
  }

  /** Buffer one delta for an item; starts the flush timer on first sight. */
  push(sessionId: string, turnId: string, itemId: string, delta: string): void {
    const k = this.key(sessionId, turnId, itemId);
    const b = this.buffers.get(k) ?? { text: '', done: false };
    b.text += delta;
    this.buffers.set(k, b);
    if (!this.timers.has(k)) {
      this.timers.set(k, this.si(() => this.flushOne(k), this.intervalMs));
    }
  }

  private flushOne(k: string): void {
    const b = this.buffers.get(k);
    if (!b) return;
    const parts = k.split('|');
    const sessionId = parts[0] ?? '';
    const turnId = parts[1] ?? '';
    const itemId = parts[2] ?? '';
    this.emit({ kind: 'message_snapshot', sessionId, turnId, itemId, text: b.text, done: b.done });
    if (b.done) {
      const t = this.timers.get(k);
      if (t) { this.ci(t); this.timers.delete(k); }
      this.buffers.delete(k);
    }
  }

  /** Finalize an item with its authoritative final text (turn end) — flushes
   *  immediately so the client never waits on the interval for the last word. */
  complete(sessionId: string, turnId: string, itemId: string, finalText?: string): void {
    const k = this.key(sessionId, turnId, itemId);
    const b = this.buffers.get(k);
    if (!b && finalText === undefined) return;
    const text = finalText ?? b?.text ?? '';
    this.buffers.set(k, { text, done: true });
    this.flushOne(k);
  }

  /** Drain every buffer for a turn (terminal event) — incomplete items flush
   *  with done:false as their last-known state. */
  flushTurn(sessionId: string, turnId: string): void {
    for (const k of [...this.buffers.keys()]) {
      if (k.startsWith(`${sessionId}|${turnId}|`)) {
        const b = this.buffers.get(k)!;
        if (!b.done) {
          b.done = true;
          this.flushOne(k);
        }
      }
    }
  }

  /** Test/introspection: buffered item count. */
  get size(): number {
    return this.buffers.size;
  }
}
