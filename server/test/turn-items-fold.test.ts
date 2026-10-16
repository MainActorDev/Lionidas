/** foldTurnEvents tests — Phase 5 step 2.
 *  Fixtures mirror the VERIFIED butler TurnEvent shapes (turn-engine.ts:50-65
 *  + EventRow schema). Real captured rows from a live DB must extend this
 *  suite before the v2 timeline route ships (verify-payload-shape law). */
import { describe, expect, it } from 'vitest';
import { foldTurnEvents, type FoldEventRow } from '../src/agent/turnItems.ts';

let seq = 0;
const row = (turn_id: string | null, kind: string, detail: Record<string, unknown>, at = 0): FoldEventRow => {
  seq += 1;
  return { id: `e${seq}`, turn_id, session_id: 's1', seq, kind, detail_json: JSON.stringify(detail), at };
};

const happyTurn = (): FoldEventRow[] => [
  row('t1', 'turn.requested', { prompt: 'why did login-flow fail?', refIds: [] }),
  row('t1', 'user_message.recorded', { role: 'user', content: 'why did login-flow fail?' }),
  row('t1', 'turn.started', {}),
  row('t1', 'tool_call', { toolCallId: 'tc1', name: 'repo.diff', arg: 'ios-consumer' }),
  row('t1', 'tool_call_update', { toolCallId: 'tc1', result: '6 files +214 -89' }),
  row('t1', 'chunk', { delta: 'The regression window is ' }),
  row('t1', 'chunk', { delta: '9f2c1ab..HEAD.' }),
  row('t1', 'usage', { cost: 0.041, contextUsed: 41000, contextWindow: 200000 }),
  row('t1', 'turn.completed', { answer: 'The regression window is 9f2c1ab..HEAD.' }),
];

describe('foldTurnEvents', () => {
  it('happy turn: user message, tool call ok, usage, assistant answer', () => {
    const items = foldTurnEvents('s1', happyTurn());
    const user = items.find((i) => i.kind === 'message' && i.role === 'user');
    expect(user).toBeDefined();
    const tool = items.find((i) => i.kind === 'mcp_tool_call');
    expect(tool).toMatchObject({ name: 'repo.diff', status: 'completed', arg: 'ios-consumer', result: '6 files +214 -89' });
    const usage = items.find((i) => i.kind === 'usage');
    expect(usage).toMatchObject({ cost: 0.041, contextUsed: 41000, contextWindow: 200000 });
    const answer = items.filter((i) => i.kind === 'message' && i.role === 'assistant');
    expect(answer).toHaveLength(1);
    expect(answer[0]).toMatchObject({ text: 'The regression window is 9f2c1ab..HEAD.', streaming: false, status: 'completed' });
    // ordering: user → tool → usage → answer
    const ord = (k: string, extra?: Record<string, unknown>) => items.find((i) => i.kind === k && (!extra || Object.entries(extra).every(([kk, vv]) => (i as unknown as Record<string, unknown>)[kk] === vv)))!.ordinal;
    expect(ord('message', { role: 'user' })).toBeLessThan(ord('mcp_tool_call'));
    expect(ord('mcp_tool_call')).toBeLessThan(ord('usage'));
    expect(ord('usage')).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });

  it('chunks are NOT emitted as a separate streaming message once the turn completed', () => {
    const items = foldTurnEvents('s1', happyTurn());
    expect(items.filter((i) => i.kind === 'message' && i.role === 'assistant' && (i as { streaming: boolean }).streaming)).toHaveLength(0);
  });

  it('tool error marks the tool item failed but the turn still completes', () => {
    const rows = happyTurn();
    rows[4] = row('t1', 'tool_call_update', { toolCallId: 'tc1', result: 'timeout', isError: true });
    const items = foldTurnEvents('s1', rows);
    expect(items.find((i) => i.kind === 'mcp_tool_call')).toMatchObject({ isError: true, status: 'failed' });
  });

  it('live turn: accumulated chunks become a streaming message; unfinished tool stays running', () => {
    const rows = [
      row('t1', 'turn.requested', { prompt: 'q', refIds: [] }),
      row('t1', 'user_message.recorded', { role: 'user', content: 'q' }),
      row('t1', 'turn.started', {}),
      row('t1', 'tool_call', { toolCallId: 'tc1', name: 'repo.search' }),
      row('t1', 'chunk', { delta: 'part...' }),
    ];
    const items = foldTurnEvents('s1', rows);
    expect(items.find((i) => i.kind === 'mcp_tool_call')).toMatchObject({ status: 'running' });
    const stream = items.find((i) => i.kind === 'message' && (i as { streaming: boolean }).streaming);
    expect(stream).toMatchObject({ role: 'assistant', text: 'part...' });
  });

  it('honest-failure rule: completed-but-empty WITH tool work → error item + preserved stream text', () => {
    const rows = [
      row('t1', 'turn.requested', { prompt: 'q', refIds: [] }),
      row('t1', 'user_message.recorded', { role: 'user', content: 'q' }),
      row('t1', 'turn.started', {}),
      row('t1', 'tool_call', { toolCallId: 'tc1', name: 'cases.list' }),
      row('t1', 'tool_call_update', { toolCallId: 'tc1', result: '12 cases' }),
      row('t1', 'chunk', { delta: 'working on it, the answer is ' }),
      row('t1', 'turn.completed', { answer: '' }),
    ];
    const items = foldTurnEvents('s1', rows);
    expect(items.find((i) => i.kind === 'error')).toMatchObject({ class: 'empty_completion' });
    const partial = items.find((i) => i.kind === 'message' && i.role === 'assistant');
    expect(partial).toMatchObject({ text: 'working on it, the answer is ', status: 'failed' });
  });

  it('empty completion WITHOUT work stays silent (no false error)', () => {
    const rows = [
      row('t1', 'turn.requested', { prompt: 'q', refIds: [] }),
      row('t1', 'user_message.recorded', { role: 'user', content: 'q' }),
      row('t1', 'turn.started', {}),
      row('t1', 'turn.completed', { answer: '' }),
    ];
    const items = foldTurnEvents('s1', rows);
    expect(items.find((i) => i.kind === 'error')).toBeUndefined();
    expect(items.find((i) => i.kind === 'message' && i.role === 'assistant')).toBeUndefined();
  });

  it('turn.failed: error item + partial stream kept visible', () => {
    const rows = [
      row('t1', 'turn.requested', { prompt: 'q', refIds: [] }),
      row('t1', 'user_message.recorded', { role: 'user', content: 'q' }),
      row('t1', 'turn.started', {}),
      row('t1', 'chunk', { delta: 'partial answer ' }),
      row('t1', 'turn.failed', { error: 'provider 500', partial: 'partial answer (partial)' }),
    ];
    const items = foldTurnEvents('s1', rows);
    expect(items.find((i) => i.kind === 'error')).toMatchObject({ class: 'provider_error', message: 'provider 500' });
    expect(items.find((i) => i.kind === 'message' && i.role === 'assistant')).toMatchObject({ text: 'partial answer (partial)' });
  });

  it('turn.aborted: cancelled error item; explicit partial beats stream text', () => {
    const rows = [
      row('t1', 'turn.requested', { prompt: 'q', refIds: [] }),
      row('t1', 'user_message.recorded', { role: 'user', content: 'q' }),
      row('t1', 'turn.started', {}),
      row('t1', 'chunk', { delta: 'some streamed text' }),
      row('t1', 'turn.aborted', { reason: 'user abort' }),
    ];
    const items = foldTurnEvents('s1', rows);
    expect(items.find((i) => i.kind === 'error')).toMatchObject({ class: 'aborted', message: 'user abort', status: 'cancelled' });
    expect(items.find((i) => i.kind === 'message' && i.role === 'assistant')).toMatchObject({ text: 'some streamed text', status: 'cancelled' });
  });

  it('queued follow-up becomes a user message with intent=queued', () => {
    const rows = [
      row(null, 'message.queued', { content: 'also check intl', disposition: 'followup' }),
      row(null, 'queue.updated', { steering: [], followUp: ['also check intl'] }),
    ];
    const items = foldTurnEvents('s1', rows);
    expect(items.find((i) => i.kind === 'message' && i.role === 'user')).toMatchObject({ intent: 'queued', text: 'also check intl' });
  });

  it('steering disposition maps to intent=steering', () => {
    const rows = [row(null, 'message.queued', { content: 'wait, do X instead', disposition: 'steering' })];
    const items = foldTurnEvents('s1', rows);
    expect(items.find((i) => i.kind === 'message' && i.role === 'user')).toMatchObject({ intent: 'steering' });
  });

  it('interrupted tool: turn failed without the tool result update', () => {
    const rows = [
      row('t1', 'turn.requested', { prompt: 'q', refIds: [] }),
      row('t1', 'user_message.recorded', { role: 'user', content: 'q' }),
      row('t1', 'turn.started', {}),
      row('t1', 'tool_call', { toolCallId: 'tc1', name: 'repo.read' }),
      row('t1', 'turn.failed', { error: 'crash mid-tool' }),
    ];
    const items = foldTurnEvents('s1', rows);
    expect(items.find((i) => i.kind === 'mcp_tool_call')).toMatchObject({ status: 'interrupted' });
  });

  it('two turns keep chronological item order even when interleaved rows arrive in seq order', () => {
    const rows = [
      row('t1', 'turn.requested', { prompt: 'a', refIds: [] }),
      row('t1', 'user_message.recorded', { role: 'user', content: 'a' }),
      row('t1', 'turn.started', {}),
      row('t1', 'turn.completed', { answer: 'first answer' }),
      row('t2', 'turn.requested', { prompt: 'b', refIds: [] }),
      row('t2', 'user_message.recorded', { role: 'user', content: 'b' }),
      row('t2', 'turn.started', {}),
      row('t2', 'turn.completed', { answer: 'second answer' }),
    ];
    const items = foldTurnEvents('s1', rows);
    const answers = items.filter((i) => i.kind === 'message' && i.role === 'assistant').map((i) => (i as { text: string }).text);
    expect(answers).toEqual(['first answer', 'second answer']);
  });

  it('compaction event becomes a compaction item', () => {
    const rows = [row('t1', 'compaction', { summary: 'trimmed 40 turns', preservedEventIds: ['e1', 'e2'] })];
    const items = foldTurnEvents('s1', rows);
    expect(items.find((i) => i.kind === 'compaction')).toMatchObject({ summary: 'trimmed 40 turns' });
  });

  it('multiple usage events: last one wins', () => {
    const rows = [
      row('t1', 'turn.started', {}),
      row('t1', 'usage', { cost: 0.01, contextUsed: 10000, contextWindow: 200000 }),
      row('t1', 'usage', { cost: 0.05, contextUsed: 60000, contextWindow: 200000 }),
      row('t1', 'turn.completed', { answer: 'done' }),
    ];
    const items = foldTurnEvents('s1', rows);
    expect(items.find((i) => i.kind === 'usage')).toMatchObject({ cost: 0.05, contextUsed: 60000 });
  });

  it('replay determinism: same rows fold to identical items', () => {
    const rows = happyTurn();
    expect(JSON.stringify(foldTurnEvents('s1', rows))).toBe(JSON.stringify(foldTurnEvents('s1', rows)));
  });

  it('textless tool-hop turn: work items only, no empty assistant bubble', () => {
    const rows = [
      row('t1', 'turn.requested', { prompt: 'q', refIds: [] }),
      row('t1', 'user_message.recorded', { role: 'user', content: 'q' }),
      row('t1', 'turn.started', {}),
      row('t1', 'tool_call', { toolCallId: 'tc1', name: 'jira.get' }),
      row('t1', 'tool_call_update', { toolCallId: 'tc1', result: 'ticket fetched' }),
      row('t1', 'turn.completed', { answer: '' }),
    ];
    const items = foldTurnEvents('s1', rows);
    // hasWork + empty answer → error (honest failure) but NO empty message bubble
    expect(items.find((i) => i.kind === 'error')).toBeDefined();
    expect(items.find((i) => i.kind === 'message' && i.role === 'assistant')).toBeUndefined();
    expect(items.find((i) => i.kind === 'mcp_tool_call')).toBeDefined();
  });
});
