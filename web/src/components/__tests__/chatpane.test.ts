import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import ChatPane from '../cockpit/ChatPane.vue';

/** F3 pinned: first message carries the [context] line; later ones don't. */

function mockFetch(responses: Array<{ ok: boolean; status?: number; body: unknown }>): ReturnType<typeof vi.fn> {
  const fn = vi.fn();
  let sessionCreated = false;
  fn.mockImplementation(async (url: string) => {
    if (url === '/api/agent/sessions' && !sessionCreated) {
      sessionCreated = true;
      return { ok: true, json: async () => ({ session: { id: 'sess_test' } }) };
    }
    const next = responses.shift() ?? { ok: true, body: { turn: { ok: true, answer: 'ok' } } };
    return { ok: next.ok, status: next.status ?? 200, json: async () => next.body };
  });
  return fn;
}

const props = { udid: 'A', deviceName: 'iPhone 14 Plus', screenState: 'home/world-sg', scenario: 'countries-sg' };

beforeEach(() => { vi.unstubAllGlobals(); });

describe('ChatPane (S4)', () => {
  it('prepends [context] to the FIRST message only (F3)', async () => {
    const fn = mockFetch([]);
    vi.stubGlobal('fetch', fn);
    const w = mount(ChatPane, { props });
    await w.find('input').setValue('what should I test?');
    await w.find('button.primary').trigger('click');
    await flushPromises();
    const firstBody = JSON.parse((fn.mock.calls[1]![1] as { body: string }).body);
    expect(firstBody.content).toContain('[context] device: iPhone 14 Plus');
    expect(firstBody.content).toContain('scenario: countries-sg');
    expect(firstBody.content).toContain('what should I test?');
    // second message: no context line
    await w.find('input').setValue('again');
    await w.find('button.primary').trigger('click');
    await flushPromises();
    const secondBody = JSON.parse((fn.mock.calls[2]![1] as { body: string }).body);
    expect(secondBody.content).toBe('again');
  });

  it('renders the agent answer; disabled composer while in flight', async () => {
    let resolveTurn: (v: unknown) => void = () => {};
    const fn = vi.fn(async (url: string) => {
      if (url === '/api/agent/sessions') return { ok: true, json: async () => ({ session: { id: 's1' } }) };
      await new Promise((r) => { resolveTurn = r; });
      return { ok: true, json: async () => ({ turn: { ok: true, answer: 'the answer' } }) };
    });
    vi.stubGlobal('fetch', fn);
    const w = mount(ChatPane, { props });
    await w.find('input').setValue('q');
    await w.find('button.primary').trigger('click');
    await flushPromises();
    expect(w.find('button.primary').attributes('disabled')).toBeDefined(); // in flight
    resolveTurn(0);
    await flushPromises();
    expect(w.text()).toContain('the answer');
    expect(w.find('button.primary').attributes('disabled')).toBeFalsy();
  });

  it('failed turn renders honestly (turn.ok false)', async () => {
    const fn = mockFetch([{ ok: true, body: { turn: { ok: false, error: 'PROVIDER_TIMEOUT' } } }]);
    vi.stubGlobal('fetch', fn);
    const w = mount(ChatPane, { props });
    await w.find('input').setValue('q');
    await w.find('button.primary').trigger('click');
    await flushPromises();
    expect(w.text()).toContain('turn failed: PROVIDER_TIMEOUT');
  });
});
