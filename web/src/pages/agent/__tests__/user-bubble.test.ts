/** User-bubble rendering (mention round): command chip + inline kind-tinted ref
 *  chips; the '[refs:]' transport suffix never shows raw. */

import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import Thread from '../components/Thread.vue';

const msgs = (m: unknown): unknown => mount(Thread, {
  props: { messages: m as never, title: 't', live: false, waiting: false, streaming: null, toolStops: [], sessionId: '' },
});

describe('user bubble chips', () => {
  it('kind-tagged refs render as inline tinted chips; no raw [refs:] suffix', async () => {
    const w = msgs([
      { role: 'user', text: 'plan this CUST-6001 using 733e224 [refs: case:CUST-6001, github-commit:ios-consumer/733e224]' },
    ]) as ReturnType<typeof mount>;
    const html = w.html();
    expect(html).not.toContain('[refs:');
    expect(html.includes('uchip jira') || html.includes('uchip case')).toBe(true);
    expect(html).toContain('uchip repo');
    w.unmount();
  });

  it('leading /planning renders as the command chip, not literal text', async () => {
    const w = msgs([
      { role: 'user', text: '/planning plan the login flow [refs: jira:CUST-1]' },
    ]) as ReturnType<typeof mount>;
    const html = w.html();
    expect(html).toContain('cmd-tag');
    expect(html).toContain('/planning');
    expect(html).not.toContain('[refs:');
    w.unmount();
  });

  it('reloaded history with bare m.refs (no suffix) still chips inline', async () => {
    const w = msgs([
      { role: 'user', text: 'check CUST-9 here', refs: [{ kind: 'jira', name: 'CUST-9' }] },
    ]) as ReturnType<typeof mount>;
    expect(w.html()).toContain('uchip jira');
    w.unmount();
  });

  it('plain messages render untouched (markdown path)', async () => {
    const w = msgs([{ role: 'user', text: 'hello there' }]) as ReturnType<typeof mount>;
    expect(w.html()).toContain('hello there');
    expect(w.html()).not.toContain('uchip');
    w.unmount();
  });
});
