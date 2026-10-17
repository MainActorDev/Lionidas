/** Phase 5 step 3 — v2 timeline route: the projection the new UI renders.
 *  GET /api/agent/sessions/:id/timeline → { items, liveTurn }
 *
 *  Parallel-run with v1 (contract-first): v1 routes untouched. The fold is
 *  the ONLY producer of replayed items; live deltas ride the WS as
 *  coalesced snapshots (deltaCoalescer). liveTurn uses the same freshness
 *  guard semantics as the v1 session read (zombie suppression). */
import type { FastifyInstance } from 'fastify';
import type { EventSink } from '@mainactordev/butler';
import { requireRole } from '../auth/roles.ts';
import type { AgentContext } from './context.ts';
import { foldTurnEvents, type TurnItem } from './turnItems.ts';

/** Zombie guard (v0.5.2 semantics): a live turn whose last event is older
 *  than 15min is dead to us — report null, never a spinning liveTurn. */
const LIVE_FRESHNESS_MS = 15 * 60 * 1000;

export function registerTimelineRoute(app: FastifyInstance, ctx: AgentContext): void {
  app.get('/api/agent/sessions/:id/timeline', { preHandler: requireRole('operator') }, async (req, rep) => {
    const { id } = req.params as { id: string };

    // session existence mirrors the storage seam the v1 read uses
    const session = await ctx.storage.getSession(id);
    if (!session) return rep.code(404).send({ error: 'session not found' });

    const items = timelineItems(ctx.sink, id);
    const liveTurn = liveTurnFor(ctx.sink, id);
    return { items, ...(liveTurn ? { liveTurn } : {}) };
  });
}

/** Fold the session's full durable event log into items. Exported for the
 *  live WS bridge to reuse (one fold implementation, replay == live).
 *
 *  NOTE: sink.events() returns butler TurnEvent objects — detail ALREADY
 *  PARSED, turn_id coalesced '' for session-level rows — NOT raw EventRows.
 *  We normalize back to the fold's row shape here (single seam). */
export function timelineItems(sink: EventSink, sessionId: string): TurnItem[] {
  const evts = (sink as unknown as {
    events(sid: string, afterSeq?: number): Array<Record<string, unknown>>;
  }).events(sessionId, 0);
  return foldTurnEvents(sessionId, evts.map((e) => ({
    id: String(e['id']),
    turn_id: e['turn_id'] ? String(e['turn_id']) : null,
    session_id: String(e['session_id']),
    seq: Number(e['seq']),
    kind: String(e['kind']),
    detail_json: JSON.stringify(e['detail'] ?? {}),
    at: Number(e['at']),
  })));
}

/** Freshness-guarded live turn (mirrors conversation.ts:107-122). */
export function liveTurnFor(sink: EventSink, sessionId: string): { turnId: string; startedAt: number } | null {
  const st = (sink as unknown as {
    state(sid: string): { activeTurnId: string | null; turns: Array<{ id: string; status: string }> };
  }).state(sessionId);
  if (!st.activeTurnId) return null;
  const rows = (sink as unknown as { events(sid: string): Array<{ at: number }> }).events(sessionId);
  const last = rows.at(-1);
  if (!last || Date.now() - last.at > LIVE_FRESHNESS_MS) return null;
  return { turnId: st.activeTurnId, startedAt: last.at };
}
