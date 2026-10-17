/** Phase 5 step 2 — the turn-item contract (t3code TurnItem pattern, adapted).
 *
 *  The ONE normalized vocabulary the v2 chat surface renders. The UI never
 *  sees raw butler events: `foldTurnEvents` (below) is the only producer for
 *  replayed history, and live adapters emit the same shapes over the bus.
 *
 *  Grounding: every kind the fold emits today maps 1:1 to a documented
 *  butler TurnEventKind. Kinds marked ADAPTER-EMITTED exist in the union for
 *  provider streams that carry richer structure (t3code parity) but are NOT
 *  synthesized by the fold — adapters degrade honestly (no invented items).
 *  See brainstorm 20261016T041716Z + plan 20261016T043100Z §1.1. */

export type TurnItemStatus =
  | 'running' // live now (tool call awaiting result, streaming message)
  | 'completed'
  | 'failed' // tool isError, or turn.failed
  | 'cancelled' // turn.aborted
  | 'interrupted'; // turn terminal but this item never finished (zombie tool)

export type TurnItemIntent = 'queued' | 'steering';

export interface TurnItemBase {
  /** Source event id for fold-derived items — stable across replays. */
  id: string;
  sessionId: string;
  turnId: string | null;
  /** Per-session ordering, from the event log seq. */
  ordinal: number;
  status: TurnItemStatus;
  startedAt: number;
  completedAt: number | null;
}

export interface MessageItem extends TurnItemBase {
  kind: 'message';
  role: 'user' | 'assistant';
  /** Streaming = a live turn's accumulated deltas; the completed answer
   *  replaces them on turn end (butler rule: the final answer renders). */
  streaming: boolean;
  text: string;
  /** queued/steered follow-ups (message.queued) — intent marker for the
   *  timeline; also how the Phase 5 UI renders the visible queue in-thread. */
  intent?: TurnItemIntent;
  /** sketch-A turn meta (assistant messages): duration/cost from the durable
   *  log; the page layers the model name. Null when the log lacks either. */
  turnMeta?: { durationMs: number | null; cost: number | null };
}

/** Reasoning block (GLM thinking_delta, Claude thinking). ADAPTER-EMITTED:
 *  butler's durable log carries text chunks only — the fold NEVER produces
 *  this kind (no synthetic reasoning). */
export interface ReasoningItem extends TurnItemBase {
  kind: 'reasoning';
  text: string;
  streaming: boolean;
}

/** A durable tool call correlated by stable toolCallId (call + update patch). */
export interface ToolCallItem extends TurnItemBase {
  kind: 'mcp_tool_call';
  toolCallId: string;
  name: string;
  arg?: string;
  result?: string;
  isError?: boolean;
}

/** Structured file op reported by a provider. ADAPTER-EMITTED (codex/opencode
 *  carry these natively; claude-cli/openai-compat surface edits as tool calls). */
export interface FileChangeItem extends TurnItemBase {
  kind: 'file_change';
  operation: string;
  path: string;
  oldPath?: string;
}

/** Shell command run by the provider harness. ADAPTER-EMITTED. */
export interface CommandExecutionItem extends TurnItemBase {
  kind: 'command_execution';
  command: string;
  exit: number | null;
  durationMs: number | null;
}

export type ErrorClass =
  | 'provider_error' // turn.failed with an error string
  | 'empty_completion' // completed-but-empty WITH a work trail (honest-failure rule)
  | 'aborted'; // turn.aborted (kept as error-shaped item so the timeline renders a verdict row)

export interface ErrorItem extends TurnItemBase {
  kind: 'error';
  class: ErrorClass;
  /** Bounded, redaction-safe message (turn.failed error / abort reason). */
  message: string;
}

/** A pending question the agent asked the user. ADAPTER-EMITTED for now;
 *  in-chat Q&A rides ordinary assistant messages until butler widens. */
export interface QuestionItem extends TurnItemBase {
  kind: 'question';
  text: string;
  answered: boolean;
}

export interface UsageItem extends TurnItemBase {
  kind: 'usage';
  /** Σ per-hop cost — advisory only (operator decision 4). */
  cost: number;
  contextUsed: number;
  contextWindow: number;
}

export interface CompactionItem extends TurnItemBase {
  kind: 'compaction';
  summary: string;
}

export type TurnItem =
  | MessageItem
  | ReasoningItem
  | ToolCallItem
  | FileChangeItem
  | CommandExecutionItem
  | ErrorItem
  | QuestionItem
  | UsageItem
  | CompactionItem;

// ── the fold ─────────────────────────────────────────────────────────────

/** Raw event-log row as persisted by butler's EventSink (EventRow shape).
 *  Tests capture REAL rows from butler_turn_events — the verify-payload-shape
 *  law: hand-invented shapes drift and pass green while the live route lies. */
export interface FoldEventRow {
  id: string;
  turn_id: string | null;
  session_id: string;
  seq: number;
  kind: string;
  detail_json: string;
  at: number;
}

interface TurnAccum {
  turnId: string;
  status: 'requested' | 'running' | 'completed' | 'failed' | 'aborted';
  /** chunks concatenated in seq order — the running-turn stream text. */
  streamText: string;
  toolCalls: Map<string, { row: FoldEventRow; name: string; arg?: string | undefined }>;
  toolUpdates: Map<string, { row: FoldEventRow; result?: string | undefined; isError?: boolean | undefined }>;
  usage: FoldEventRow | null;
  usageDetail: { cost: number; contextUsed: number; contextWindow: number } | null;
  answer: string | null;
  failError: string | null;
  failPartial: string | null;
  abortReason: string | null;
  hasWork: boolean;
  /** turn lifecycle instants (event `at`), for meta lines/durations */
  startedAt: number | null;
  endedAt: number | null;
}

const EMPTY_MSG_RE = /^\s*$/;

/**
 * Pure projection: butler turn events → normalized TurnItems, in session seq
 * order. Replay invariant: fold(log of a finished session) is byte-identical
 * to the items the live stream produced (same ids from the same events).
 *
 * Truth rules encoded here (crucible/agent-chat-ui):
 *  - textless tool-hop turns render as work items, never empty bubbles.
 *  - turn.completed with an empty answer AND a real work trail → error item
 *    class 'empty_completion' (minutes of work must not vanish silently).
 *  - turn.failed keeps its partial stream visible (partial ? partial : stream).
 *  - queued/steered messages become message items with intent markers.
 *  - a tool call whose turn ended without its update → 'interrupted'.
 */
export function foldTurnEvents(sessionId: string, rows: FoldEventRow[]): TurnItem[] {
  // pass 1: accumulate per turn, in seq order
  const turns = new Map<string, TurnAccum>();
  const turnOrder: string[] = [];
  // session-scope items (queued messages can carry turn_id of the ACTIVE turn
  // in legacy rows; treat null-turn rows as session-level)
  const sessionEvents: FoldEventRow[] = [];
  const usagePerTurn = new Map<string, Array<{ row: FoldEventRow; detail: { cost: number; contextUsed: number; contextWindow: number } }>>();

  for (const r of rows) {
    const tid = r.turn_id ?? '';
    if (!tid) {
      sessionEvents.push(r);
      continue;
    }
    let t = turns.get(tid);
    if (!t) {
      t = {
        turnId: tid, status: 'requested', streamText: '',
        toolCalls: new Map(), toolUpdates: new Map(),
        usage: null, usageDetail: null,
        answer: null, failError: null, failPartial: null, abortReason: null,
        hasWork: false, startedAt: null, endedAt: null,
      };
      turns.set(tid, t);
      turnOrder.push(tid);
    }
    const d = safeJson(r.detail_json);
    switch (r.kind) {
      case 'turn.started': t.status = 'running'; if (t.startedAt === null) t.startedAt = r.at; break;
      case 'chunk': t.streamText += typeof d?.['delta'] === 'string' ? d['delta'] : ''; break;
      case 'tool_call':
        t.hasWork = true;
        t.toolCalls.set(String(d?.['toolCallId'] ?? r.id), { row: r, name: String(d?.['name'] ?? 'tool'), arg: d?.['arg'] !== undefined && d?.['arg'] !== null ? String(d['arg']) : undefined });
        break;
      case 'tool_call_update':
        t.toolUpdates.set(String(d?.['toolCallId'] ?? ''), { row: r, result: d?.['result'] !== undefined && d?.['result'] !== null ? String(d['result']) : undefined, isError: d?.['isError'] === true });
        break;
      case 'usage': {
        const detail = { cost: Number(d?.['cost'] ?? 0), contextUsed: Number(d?.['contextUsed'] ?? 0), contextWindow: Number(d?.['contextWindow'] ?? 0) };
        t.usage = r; t.usageDetail = detail;
        const list = usagePerTurn.get(tid) ?? []; list.push({ row: r, detail }); usagePerTurn.set(tid, list);
        break;
      }
      case 'compaction': break; // emitted in pass 2 from the raw row
      case 'turn.completed': t.status = 'completed'; t.answer = typeof d?.['answer'] === 'string' ? d['answer'] : ''; t.endedAt = r.at; break;
      case 'turn.failed': t.status = 'failed'; t.failError = String(d?.['error'] ?? 'turn failed'); t.failPartial = typeof d?.['partial'] === 'string' ? d['partial'] : null; t.endedAt = r.at; break;
      case 'turn.aborted': t.status = 'aborted'; t.abortReason = String(d?.['reason'] ?? 'aborted'); t.endedAt = r.at; break;
      default: break; // turn.requested/user_message.recorded/queue.* handled in pass 2
    }
  }

  const items: TurnItem[] = [];
  const emit = (i: TurnItem) => items.push(i);

  const turnStatusForItem = (t: TurnAccum): TurnItemStatus => {
    switch (t.status) {
      case 'completed': return 'completed';
      case 'failed': return 'failed';
      case 'aborted': return 'cancelled';
      default: return 'running'; // requested/running (live)
    }
  };

  /** sketch-A turn meta line: `agent · 2m 41s · $0.041` (model is not in the
   *  durable log — the page layers it; duration/cost come from events). */
  const durationMs = (t: TurnAccum): number | null =>
    t.startedAt !== null && t.endedAt !== null ? Math.max(0, t.endedAt - t.startedAt) : null;

  // pass 2: emit in ORIGINAL event order — walk rows again, emitting per-turn
  // structures when their anchor event appears, so interleaved sessions keep
  // chronology.
  const emittedTurnStructs = new Set<string>();
  const emittedCompactions = new Set<string>();
  const emittedSessionQueued = new Set<string>();

  const flushTurn = (t: TurnAccum) => {
    const terminal = turnStatusForItem(t);
    // tool items (interrupted = terminal turn, call never updated)
    for (const [callId, call] of t.toolCalls) {
      const upd = t.toolUpdates.get(callId);
      emit({
        kind: 'mcp_tool_call',
        id: call.row.id,
        sessionId, turnId: t.turnId,
        ordinal: call.row.seq,
        status: upd ? (upd.isError ? 'failed' : 'completed') : (terminal === 'running' ? 'running' : 'interrupted'),
        startedAt: call.row.at,
        completedAt: upd ? upd.row.at : null,
        toolCallId: callId,
        name: call.name,
        ...(call.arg !== undefined && call.arg !== null ? { arg: String(call.arg) } : {}),
        ...(upd?.result !== undefined && upd.result !== null ? { result: String(upd.result) } : {}),
        ...(upd?.isError ? { isError: true } : {}),
      });
    }
    // usage item (last usage event wins — the freshest meters)
    if (t.usage && t.usageDetail) {
      emit({
        kind: 'usage', id: t.usage.id, sessionId, turnId: t.turnId,
        ordinal: t.usage.seq, status: 'completed', startedAt: t.usage.at, completedAt: t.usage.at,
        cost: t.usageDetail.cost, contextUsed: t.usageDetail.contextUsed, contextWindow: t.usageDetail.contextWindow,
      });
    }
    const meta = { durationMs: durationMs(t), cost: t.usageDetail?.cost ?? null };
    // verdict + assistant message
    if (t.status === 'completed') {
      if (EMPTY_MSG_RE.test(t.answer ?? '')) {
        if (t.hasWork) {
          // honest-failure rule: real work, no answer → error, work preserved
          emit({
            kind: 'error', id: `err-${t.turnId}`, sessionId, turnId: t.turnId,
            ordinal: Number.MAX_SAFE_INTEGER - 1, status: 'failed',
            startedAt: 0, completedAt: 0,
            class: 'empty_completion',
            message: 'turn completed with an empty answer after tool work — partial work is preserved below',
          });
          if (!EMPTY_MSG_RE.test(t.streamText)) {
            emit({ kind: 'message', id: `msg-a-${t.turnId}`, sessionId, turnId: t.turnId, ordinal: Number.MAX_SAFE_INTEGER, status: 'failed', startedAt: t.startedAt ?? 0, completedAt: t.endedAt ?? null, role: 'assistant', streaming: false, text: t.streamText, turnMeta: meta });
          }
        }
        // empty-on-no-work stays a completion — no items (skill rule)
      } else {
        emit({ kind: 'message', id: `msg-a-${t.turnId}`, sessionId, turnId: t.turnId, ordinal: Number.MAX_SAFE_INTEGER, status: 'completed', startedAt: t.startedAt ?? 0, completedAt: t.endedAt ?? null, role: 'assistant', streaming: false, text: t.answer ?? '', turnMeta: meta });
      }
    } else if (t.status === 'failed') {
      emit({
        kind: 'error', id: `err-${t.turnId}`, sessionId, turnId: t.turnId,
        ordinal: Number.MAX_SAFE_INTEGER - 1, status: 'failed', startedAt: 0, completedAt: 0,
        class: 'provider_error', message: t.failError ?? 'turn failed',
      });
      const partial = t.failPartial ?? t.streamText;
      if (!EMPTY_MSG_RE.test(partial)) {
        emit({ kind: 'message', id: `msg-a-${t.turnId}`, sessionId, turnId: t.turnId, ordinal: Number.MAX_SAFE_INTEGER, status: 'failed', startedAt: t.startedAt ?? 0, completedAt: t.endedAt ?? null, role: 'assistant', streaming: false, text: partial, turnMeta: meta });
      }
    } else if (t.status === 'aborted') {
      emit({
        kind: 'error', id: `err-${t.turnId}`, sessionId, turnId: t.turnId,
        ordinal: Number.MAX_SAFE_INTEGER - 1, status: 'cancelled', startedAt: 0, completedAt: 0,
        class: 'aborted', message: t.abortReason ?? 'aborted',
      });
      if (!EMPTY_MSG_RE.test(t.streamText)) {
        emit({ kind: 'message', id: `msg-a-${t.turnId}`, sessionId, turnId: t.turnId, ordinal: Number.MAX_SAFE_INTEGER, status: 'cancelled', startedAt: t.startedAt ?? 0, completedAt: t.endedAt ?? null, role: 'assistant', streaming: false, text: t.streamText, turnMeta: meta });
      }
    } else {
      // live turn: streaming assistant message from accumulated chunks
      if (!EMPTY_MSG_RE.test(t.streamText)) {
        emit({ kind: 'message', id: `msg-a-${t.turnId}`, sessionId, turnId: t.turnId, ordinal: Number.MAX_SAFE_INTEGER, status: 'running', startedAt: t.startedAt ?? 0, completedAt: null, role: 'assistant', streaming: true, text: t.streamText, turnMeta: meta });
      }
    }
  };

  for (const r of rows) {
    const tid = r.turn_id ?? '';
    const d = safeJson(r.detail_json);
    if (r.kind === 'user_message.recorded') {
      const role = d?.['role'] === 'assistant' ? 'assistant' : 'user';
      emit({ kind: 'message', id: r.id, sessionId, turnId: tid || null, ordinal: r.seq, status: 'completed', startedAt: r.at, completedAt: r.at, role, streaming: false, text: String(d?.['content'] ?? '') });
      continue;
    }
    if (r.kind === 'message.queued') {
      const intent = d?.['disposition'] === 'steering' ? 'steering' : 'queued';
      emit({ kind: 'message', id: r.id, sessionId, turnId: tid || null, ordinal: r.seq, status: 'completed', startedAt: r.at, completedAt: r.at, role: 'user', streaming: false, text: String(d?.['content'] ?? ''), intent });
      continue;
    }
    if (r.kind === 'compaction' && !emittedCompactions.has(r.id)) {
      emittedCompactions.add(r.id);
      emit({ kind: 'compaction', id: r.id, sessionId, turnId: tid || null, ordinal: r.seq, status: 'completed', startedAt: r.at, completedAt: r.at, summary: String(d?.['summary'] ?? '') });
      continue;
    }
    if (tid && !emittedTurnStructs.has(tid) && turns.has(tid)) {
      // flush this turn's structures at its FIRST structural event that isn't
      // handled above — keeps chronology while emitting each turn exactly once.
      const t = turns.get(tid)!;
      if (r.kind === 'tool_call' || r.kind === 'turn.completed' || r.kind === 'turn.failed' || r.kind === 'turn.aborted' || r.kind === 'usage') {
        emittedTurnStructs.add(tid);
        flushTurn(t);
      }
    }
  }
  // turns whose rows were fully consumed without a structural anchor (rare:
  // log truncated mid-turn) still flush, in order.
  for (const tid of turnOrder) {
    if (!emittedTurnStructs.has(tid)) {
      emittedTurnStructs.add(tid);
      flushTurn(turns.get(tid)!);
    }
  }
  void sessionEvents; void emittedSessionQueued; void usagePerTurn;
  items.sort((a, b) => a.ordinal - b.ordinal);
  return items;
}

function safeJson(s: string): Record<string, unknown> | null {
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return null; }
}
