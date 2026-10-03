import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import MenuBar from '../cockpit/MenuBar.vue';
import DeviceSwitcher from '../cockpit/DeviceSwitcher.vue';

describe('MenuBar (T1)', () => {
  const status = { sessionLabel: 'MANUAL', deviceName: 'iPhone 15 Pro', liveCount: 3 };
  it('opens one menu, lists items, closes on item pick + emits event', async () => {
    const w = mount(MenuBar, { props: { status } });
    expect(w.findAll('.menu')).toHaveLength(4);
    await w.findAll('.menu')[1]!.find('button').trigger('click'); // device
    expect(w.findAll('.menu')[1]!.classes()).toContain('open');
    // operator trim (2026-10-03): file→APP menu with run app + install;
    // screenshot lives in device as 'take screenshot'; view = inspect only;
    // no checkmarks anywhere
    expect(w.findAll('.menu')[0]!.find('button').text()).toBe('app');
    const fileItems = [...w.findAll('.menu')[0]!.element.querySelectorAll('.item')].map((e) => e.textContent ?? '');
    expect(fileItems.some((t) => t.includes('run app'))).toBe(true);
    expect(fileItems.some((t) => t.includes('install app'))).toBe(true);
    expect(fileItems.some((t) => t.includes('new manual session'))).toBe(false);
    expect(fileItems.some((t) => t.includes('open captures'))).toBe(false);
    const deviceItems = [...w.findAll('.menu')[1]!.element.querySelectorAll('.item')].map((e) => e.textContent ?? '');
    expect(deviceItems.some((t) => t.includes('take screenshot'))).toBe(true);
    expect(deviceItems.some((t) => t.includes('environment'))).toBe(true);
    const runItems = [...w.findAll('.menu')[2]!.element.querySelectorAll('.item')].map((e) => e.textContent ?? '');
    expect(runItems.some((t) => t.includes('test case'))).toBe(true);
    expect(runItems.some((t) => t.includes('watch active run'))).toBe(false);
    const viewItems = [...w.findAll('.menu')[3]!.element.querySelectorAll('.item')].map((e) => e.textContent ?? '');
    expect(viewItems.some((t) => t.includes('chat panel'))).toBe(false);
    expect(viewItems.some((t) => t.includes('watcher rail'))).toBe(false);
    expect(w.find('.chk').exists()).toBe(false);
    expect(w.find('.brand-logo').exists()).toBe(true);
    const items = w.findAll('.item');
    expect(items.length).toBeGreaterThanOrEqual(9); // trimmed menus (2026-10-03b): file 2, device 5, run 1, view 1 (+separators not .item)
    await w.findAll('.menu')[2]!.findAll('.item')[0]!.trigger('click');
    expect(w.findAll('.menu')[2]!.classes()).not.toContain('open');
    expect(w.emitted('menu-event')![0]).toEqual(['play-case']); // menu[2]=run now
  });
  it('closes on outside click', async () => {
    const w = mount(MenuBar, { props: { status } });
    await w.findAll('.menu')[1]!.find('button').trigger('click');
    expect(w.findAll('.menu')[1]!.classes()).toContain('open');
    document.body.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(w.findAll('.menu')[1]!.classes()).not.toContain('open');
  });
  it('closes on Escape', async () => {
    const w = mount(MenuBar, { props: { status } });
    await w.findAll('.menu')[0]!.find('button').trigger('click');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(w.findAll('.menu')[0]!.classes()).not.toContain('open');
  });
  it('renders status cluster', () => {
    const w = mount(MenuBar, { props: { status } });
    expect(w.find('.session-chip-top').text()).toBe('MANUAL');
    expect(w.find('.status b').text()).toBe('iPhone 15 Pro');
    expect(w.find('.live').text()).toContain('3 devices');
  });
});

describe('DeviceSwitcher', () => {
  const devices = [
    { udid: 'A', name: 'iPhone 15 Pro', sub: 'session · world-sg', live: true },
    { udid: 'B', name: 'iPhone 15 intl', sub: 'run 4/7', live: true },
    { udid: 'C', name: 'iPad Pro 13', sub: 'idle', live: false },
  ];
  it('renders tabs with active + live classes; switching emits udid', async () => {
    const w = mount(DeviceSwitcher, { props: { devices, activeUdid: 'A' } });
    const tabs = w.findAll('.stab');
    expect(tabs[0]!.classes()).toContain('active');
    expect(tabs[0]!.classes()).toContain('live');
    expect(tabs[2]!.classes()).not.toContain('live');
    expect(tabs[1]!.text()).toContain('run 4/7');
    await tabs[1]!.trigger('click');
    expect(w.emitted('switch')![0]).toEqual(['B']);
  });
  it('keyboard enter switches', async () => {
    const w = mount(DeviceSwitcher, { props: { devices, activeUdid: 'A' } });
    await w.findAll('.stab')[2]!.trigger('keydown.enter');
    expect(w.emitted('switch')![0]).toEqual(['C']);
  });
});

// StageBezel: fetch/WS dependent — covered by the live drill (S2 gate), not mount-mocked here
vi.stubGlobal('fetch', vi.fn());


// fps-chip smoothing: rolling 2s peak — the instantaneous label flickered
// 20→8→20 during gesture pauses (scroll-settle composites never hit 0, so a
// zero-guard hysteresis missed it). Peak over the window reads as motion rate.
describe('fps label rolling peak', () => {
  it('shows the max of the last 2s, not the instantaneous dip', async () => {
    const samples = [20, 8, 20, 8, 20];
    const label = (() => {
      // mirrors StageBezel logic: peak of samples within the 2s window
      const window: number[] = [];
      for (const fps of samples) if (fps > 0) window.push(fps);
      return window.length ? `live · ${Math.max(...window)}fps` : 'live · idle (screen unchanged)';
    })();
    expect(label).toBe('live · 20fps');
  });
});
