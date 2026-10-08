import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createRouter, createMemoryHistory, type Router } from 'vue-router';
import App from '../../App.vue';

// App shell mounts the real router; pages themselves fetch data on mount —
// stub every page component so the drill targets the shell (sidebar) only.
// fetch stub: auth probe returns a user (else the guard bounces to /login),
// CmdPalette's /api/devices returns an empty boot list.
let currentRole = 'admin';
const routes = [
  { path: '/login', name: 'login', component: { template: '<div id="stub-page" />' }, meta: { public: true } },
  { path: '/', name: 'overview', component: { template: '<div id="stub-page" />' } },
  { path: '/suites', name: 'suites', component: { template: '<div id="stub-page" />' } },
  { path: '/devices', name: 'wall', component: { template: '<div id="stub-page" />' } },
  { path: '/runs', name: 'runs', component: { template: '<div id="stub-page" />' } },
  { path: '/runs/:id', name: 'runDetail', component: { template: '<div id="stub-page" />' } },
  { path: '/templates', name: 'templates', component: { template: '<div id="stub-page" />' } },
  { path: '/screens', name: 'screens', component: { template: '<div id="stub-page" />' } },
  { path: '/env', name: 'env', component: { template: '<div id="stub-page" />' } },
  { path: '/forge', name: 'forge', component: { template: '<div id="stub-page" />' } },
  { path: '/users', name: 'users', component: { template: '<div id="stub-page" />' } },
  { path: '/projects', name: 'projects', component: { template: '<div id="stub-page" />' } },
  { path: '/builds', name: 'builds', component: { template: '<div id="stub-page" />' } },
  { path: '/settings', name: 'settings', component: { template: '<div id="stub-page" />' } },
  { path: '/guide', name: 'guide', component: { template: '<div id="stub-page" />' } },
];

async function makeApp(path = '/', role = 'admin'): Promise<{ wrapper: ReturnType<typeof mount>; router: Router }> {
  currentRole = role;
  const router = createRouter({ history: createMemoryHistory(), routes });
  router.push(path);
  await router.isReady();
  const wrapper = mount(App, { global: { plugins: [router] } });
  await flushPromises();
  return { wrapper, router };
}

describe('app shell sidebar (025-A collapsible tree)', () => {
  beforeEach(() => {
    currentRole = 'admin';
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/devices')) return { ok: true, json: async () => ({ devices: [] }) } as Response;
      if (url.includes('/api/runs')) return { ok: true, json: async () => ({ runs: [] }) } as Response;
      return { ok: true, json: async () => ({ user: { name: 'drill', role: currentRole } }) } as Response;
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('renders four collapsible groups plus the standalone guide (admin)', async () => {
    const { wrapper } = await makeApp('/');
    const heads = wrapper.findAll('.nav-grp-head');
    // text() includes the caret glyph — compare normalized labels
    expect(heads.map(h => h.text().replace('▾', '').trim())).toEqual(['testing', 'ci', 'library', 'system']);
    const items = wrapper.findAll('.nav-item');
    expect(items).toHaveLength(13);
    expect(items.map(i => i.text())).toEqual([
      'overview', 'suites', 'devices', 'runs',
      'projects', 'builds',
      'test cases', 'screens', 'env', 'network',
      'users', 'settings',
      'guide', // standalone footer link, outside any group
    ]);
    // all groups expanded by default
    expect(wrapper.findAll('.nav-grp-kids')).toHaveLength(4);
    expect(wrapper.findAll('.nav-grp.closed')).toHaveLength(0);
    // the guide link carries its own class and sits outside .nav-grp
    const guide = items.find(i => i.text() === 'guide')!;
    expect(guide.classes()).toContain('nav-guide');
  });

  it('non-admins: no adminOnly items, ci+system groups hide entirely, guide stays', async () => {
    const { wrapper } = await makeApp('/', 'operator');
    const items = wrapper.findAll('.nav-item').map(i => i.text());
    expect(items).toEqual([
      'overview', 'suites', 'devices', 'runs',
      'test cases', 'screens', 'env', 'network',
      'guide', // visible to everyone
    ]);
    // users is adminOnly too — no dead 403 link for operators
    expect(items).not.toContain('users');
    const heads = wrapper.findAll('.nav-grp-head').map(h => h.text().replace('▾', '').trim());
    expect(heads).toEqual(['testing', 'library']); // ci & system emptied → hidden
  });

  it('toggles a group closed and hides its children', async () => {
    const { wrapper } = await makeApp('/');
    const head = wrapper.findAll('.nav-grp-head')[2]; // library
    expect(head.attributes('aria-expanded')).toBe('true');
    await head.trigger('click');
    const grp = wrapper.findAll('.nav-grp')[2];
    expect(grp.classes()).toContain('closed');
    expect(head.attributes('aria-expanded')).toBe('false');
    // v-show keeps DOM; children hidden
    const kids = grp.find('.nav-grp-kids');
    expect(kids?.element).toBeTruthy();
    expect((kids?.element as HTMLElement).style.display).toBe('none');
  });

  it('marks the active item and its group head; run detail keeps runs active', async () => {
    const { wrapper } = await makeApp('/runs/abc');
    const active = wrapper.findAll('.nav-item').find(i => i.classes().includes('active'));
    expect(active?.text()).toBe('runs');
    const heads = wrapper.findAll('.nav-grp-head');
    expect(heads[0].classes()).toContain('on'); // testing
    expect(heads[1].classes()).not.toContain('on'); // ci (no active item)
  });

  it('auto-expands a collapsed group when navigation lands inside it', async () => {
    const { wrapper, router } = await makeApp('/');
    const head = wrapper.findAll('.nav-grp-head')[3]; // system
    await head.trigger('click');
    expect(wrapper.findAll('.nav-grp')[3].classes()).toContain('closed');
    await router.push('/users');
    await flushPromises();
    expect(wrapper.findAll('.nav-grp')[3].classes()).not.toContain('closed');
    const active = wrapper.findAll('.nav-item').find(i => i.classes().includes('active'));
    expect(active?.text()).toBe('users');
  });

  it('navigates via group child links', async () => {
    const { wrapper, router } = await makeApp('/');
    const link = wrapper.findAll('.nav-item').find(i => i.text() === 'network');
    await link!.trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.name).toBe('forge');
  });
});
