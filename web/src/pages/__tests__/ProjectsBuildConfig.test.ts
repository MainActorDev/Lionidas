/** Projects page build-config UI (S3/S4): the chip renders the three honest
 *  states + verdicts; derive/verify buttons appear only when their
 *  preconditions hold (admin-gated page). */
import { describe, expect, it } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import ProjectsPage from '../ProjectsPage.vue';

// minimal fetch mock: /api endpoints the page loads on mount
function mockFetch() {
  const projects = [
    { id: 'p1', name: 'intl', repoUrl: 'x', localPath: null, defaultBranch: 'main', authSet: false, defaultSuiteId: null, retention: null, updatedAt: Date.now(), buildConfigState: 'found:dot-lionidas-manifest' },
    { id: 'p2', name: 'consumer', repoUrl: 'y', localPath: null, defaultBranch: 'main', authSet: false, defaultSuiteId: null, retention: null, updatedAt: Date.now(), buildConfigState: 'blocked' },
  ];
  const state: Record<string, unknown> = {
    '/api/projects': { projects },
    '/api/suites': { suites: [] },
    '/api/settings/repos-dir': { dir: '/repos' },
  };
  global.fetch = (async (url: string, init?: RequestInit) => {
    const u = url.split('?')[0]!;
    if (state[u]) return new Response(JSON.stringify(state[u]), { status: 200 });
    if (u === '/api/packages') return new Response(JSON.stringify({ packages: [] }), { status: 200 });
    if (u.startsWith('/api/projects/') && u.endsWith('/workspace')) {
      return new Response(JSON.stringify({ status: { exists: true, branch: 'main', head: 'abc', dirty: 0, manifest: null, manifestRaw: null, manifestError: null } }), { status: 200 });
    }
    if (u.endsWith('/build-config/detect')) {
      const id = u.split('/')[3]!;
      return new Response(JSON.stringify({ buildConfig: id === 'p2' ? { state: 'blocked', blockers: [{ code: 'PODS_UNINSTALLED', detail: 'CocoaPods repo with no Pods/ directory', evidence: 'Podfile' }] } : { state: 'found', source: 'dot-lionidas-manifest', legacy: true } }), { status: 200 });
    }
    if (u.endsWith('/build-config')) {
      const id = u.split('/')[3]!;
      return new Response(JSON.stringify({ recipe: id === 'p1' ? { id: 'rcp1', revision: 1, transport: 'generic', scheme: 'INTL', configuration: 'Debug', prepare: [], generated: false, verifyState: 'green', verifiedAt: Date.now() } : null }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: 'unmocked ' + u }), { status: init?.method === 'POST' ? 200 : 404 });
  }) as typeof fetch;
}

async function mounted() {
  mockFetch();
  const w = mount(ProjectsPage);
  await flushPromises();
  return w;
}

describe('Projects page — build-config column', () => {
  it('renders chips: verified green for intl, blocked for consumer', async () => {
    const w = await mounted();
    const chips = w.findAll('.pj-bc');
    expect(chips.length).toBe(2);
    expect(chips[0]!.text()).toContain('rev1');
    expect(chips[0]!.text()).toContain('verified');
    expect(chips[0]!.find('.bc-dot').classes()).toContain('ok');
    expect(chips[1]!.text()).toContain('blocked');
    expect(chips[1]!.find('.bc-dot').classes()).toContain('bad');
  });

  it('editor panel: blockers with evidence + the propose hint for a blocked project', async () => {
    const w = await mounted();
    await w.findAll('.pj-row').filter((r) => r.text().includes('consumer'))[0]!.trigger('click');
    await flushPromises();
    const panel = w.find('.ed-bc');
    expect(panel.exists()).toBe(true);
    expect(panel.text()).toContain('PODS_UNINSTALLED');
    expect(panel.text()).toContain('Podfile');
    expect(panel.text()).toContain('/build-config-propose');
    // derive button NOT offered when blocked
    expect(panel.text()).not.toContain('derive config');
  });

  it('editor panel: active config shows verdict + verify button; generated flag when derived', async () => {
    const w = await mounted();
    await w.findAll('.pj-row').filter((r) => r.text().includes('intl'))[0]!.trigger('click');
    await flushPromises();
    const panel = w.find('.ed-bc');
    expect(panel.text()).toContain('rev 1');
    expect(panel.text()).toContain('verified');
    expect(panel.text()).toContain('verify build'); // re-verify offered
    expect(panel.find('.ed-bc-gen').exists()).toBe(false); // not generated
  });
});
