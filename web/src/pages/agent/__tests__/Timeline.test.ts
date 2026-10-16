/** Timeline component tests — Phase 5 step 4.
 *  Renders item kinds from the timelineTypes contract; asserts the
 *  ai-elements-derived semantics: role=log, directional bubbles, collapsible
 *  work rows with always-visible status, honest error rows, empty state. */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import Timeline from '../components/Timeline.vue';
import WorkRow from '../components/WorkRow.vue';
import type { TurnItem } from '../components/timelineTypes';

const base = (over: Record<string, unknown> & { kind: string; id: string }): TurnItem =>
  ({ sessionId: 's1', turnId: 't1', ordinal: 1, status: 'completed', startedAt: 0, completedAt: 0, ...over } as TurnItem);

const fixture = (): TurnItem[] => [
  base({ kind: 'message', id: 'm1', role: 'user', streaming: false, text: 'why did login-flow fail?' }),
  base({ kind: 'mcp_tool_call', id: 'w1', toolCallId: 'tc1', name: 'repo.diff', arg: 'ios-consumer', result: '6 files', status: 'completed' }),
  base({ kind: 'usage', id: 'u1', cost: 0.041, contextUsed: 41000, contextWindow: 200000 }),
  base({ kind: 'message', id: 'm2', role: 'assistant', streaming: false, text: 'The regression window is `9f2c1ab..HEAD`.' }),
];

describe('Timeline', () => {
  it('renders the container as a labelled log region', () => {
    const w = mount(Timeline, { props: { items: fixture() }, global: { stubs: { ScrollPill: true } } });
    expect(w.find('[role="log"]').exists()).toBe(true);
    expect(w.find('[role="log"]').attributes('aria-label')).toBe('conversation');
  });

  it('renders every item kind it receives (tool detail collapsed by default)', async () => {
    const w = mount(Timeline, { props: { items: fixture() }, global: { stubs: { ScrollPill: true } } });
    expect(w.findAll('.bubble-user').length).toBe(1);
    expect(w.findAll('.assistant').length).toBe(1);
    expect(w.text()).toContain('repo.diff');
    expect(w.text()).toContain('$0.041');
    // detail rides in the collapsible; expand reveals the result line
    await w.findComponent(WorkRow).find('.wr-head').trigger('click');
    await new Promise((r) => setTimeout(r, 0));
    expect(w.findComponent(WorkRow).text()).toContain('6 files');
  });

  it('user bubble is directional (is-user class), assistant not', () => {
    const w = mount(Timeline, { props: { items: fixture() }, global: { stubs: { ScrollPill: true } } });
    const bubbles = w.findAllComponents(MessageBubbleStub);
    expect(bubbles[0]!.classes()).toContain('is-user');
    expect(bubbles[1]!.classes()).toContain('is-assistant');
  });

  it('error item renders an honest status row with its message', () => {
    const items = [...fixture(), base({ kind: 'error', id: 'e1', class: 'empty_completion', message: 'turn completed with an empty answer after tool work', status: 'failed' })];
    const w = mount(Timeline, { props: { items }, global: { stubs: { ScrollPill: true } } });
    expect(w.find('[role="status"]').text()).toContain('empty answer');
  });

  it('streaming message carries the cursor affordance and sr-only announcement', () => {
    const items = [base({ kind: 'message', id: 'm3', role: 'assistant', streaming: true, text: 'part…', status: 'running' })];
    const w = mount(Timeline, { props: { items }, global: { stubs: { ScrollPill: true } } });
    expect(w.find('.cursor').exists()).toBe(true);
    expect(w.find('.sr-only').text()).toContain('streaming');
  });

  it('empty state shows title + description', () => {
    const w = mount(Timeline, { props: { items: [] }, global: { stubs: { ScrollPill: true } } });
    expect(w.find('.tl-empty h3').text()).toBe('no messages yet');
  });

  it('work row receives honest status props from the item', () => {
    const items = [base({ kind: 'mcp_tool_call', id: 'w2', toolCallId: 'tc2', name: 'repo.read', arg: 'x', result: 'timeout', isError: true, status: 'failed' })];
    const w = mount(Timeline, { props: { items }, global: { stubs: { ScrollPill: true } } });
    const row = w.findComponent(WorkRow);
    expect(row.props('status')).toBe('failed');
    expect(row.props('isError')).toBe(true);
  });
});

// stub typing bridge for findAllComponents
import MessageBubble from '../components/MessageBubble.vue';
const MessageBubbleStub = MessageBubble;

describe('WorkRow', () => {
  type WRStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  it('header trigger is aria-labelled with name + status', () => {
    const w = mount(WorkRow, { props: { name: 'cases.list', status: 'completed' as WRStatus, arg: 'tpl', result: '12 rows' } });
    expect(w.find('.wr-head').attributes('aria-label')).toBe('tool cases.list, done');
  });

  it('completed-with-error shows the error label, not done', () => {
    const w = mount(WorkRow, { props: { name: 'repo.read', status: 'failed' as WRStatus, isError: true, arg: 'f', result: 'timeout' } });
    expect(w.find('.wr-head').attributes('aria-label')).toBe('tool repo.read, error');
  });

  it('rows without detail render a visible status line (no dead trigger)', () => {
    const w = mount(WorkRow, { props: { name: 'repo.search', status: 'running' as WRStatus } });
    expect(w.find('.wr-head').attributes('disabled')).toBeDefined();
    expect(w.find('.wr-status').text()).toBe('running');
  });
});
