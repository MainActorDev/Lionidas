import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import MenuBar from '../cockpit/MenuBar.vue';
import DeviceSwitcher from '../cockpit/DeviceSwitcher.vue';

describe('MenuBar (T1)', () => {
  const status = { sessionLabel: 'MANUAL', deviceName: 'iPhone 15 Pro', liveCount: 3 };
  it('opens one menu, lists items, closes on item pick + emits event', async () => {
    const w = mount(MenuBar, { props: { status } });
    expect(w.findAll('.menu')).toHaveLength(5);
    await w.findAll('.menu')[2]!.find('button').trigger('click'); // environment
    expect(w.findAll('.menu')[2]!.classes()).toContain('open');
    const items = w.findAll('.item');
    expect(items.length).toBeGreaterThan(10); // items across menus (only open one visible via CSS class; DOM has all)
    await w.findAll('.menu')[2]!.findAll('.item')[0]!.trigger('click');
    expect(w.findAll('.menu')[2]!.classes()).not.toContain('open');
    expect(w.emitted('menu-event')![0]).toEqual(['env-scenario']);
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
