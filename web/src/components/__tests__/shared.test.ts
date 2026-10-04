import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import WatcherPanel from '../shared/WatcherPanel.vue';
import WatcherSection from '../shared/WatcherSection.vue';
import WatcherSteps from '../shared/WatcherSteps.vue';
import LogTail from '../shared/LogTail.vue';
import SideDrawer from '../shared/SideDrawer.vue';

describe('WatcherPanel (reusable rail container)', () => {
  const tabs = [{ id: 'watch', label: 'watch' }, { id: 'chat', label: 'chat' }];
  it('renders tabs with active state + emits switch', async () => {
    const w = mount(WatcherPanel, { props: { tabs, active: 'watch' } });
    const el = w.findAll('.rtab');
    expect(el).toHaveLength(2);
    expect(el[0]!.classes()).toContain('active');
    expect(el[1]!.classes()).not.toContain('active');
    await el[1]!.trigger('click');
    expect(w.emitted('switch')![0]).toEqual(['chat']);
  });
  it('renders slot panes', () => {
    const w = mount(WatcherPanel, { props: { tabs, active: 'watch' }, slots: { default: '<div class="pane-x">hi</div>' } });
    expect(w.find('.pane-x').exists()).toBe(true);
  });
});

describe('WatcherSection', () => {
  it('collapses and expands on header click', async () => {
    const w = mount(WatcherSection, { props: { title: 'session', meta: 'live' }, slots: { default: '<div class="row">lease</div>' } });
    expect(w.find('.row').exists()).toBe(true);
    await w.find('h3').trigger('click');
    expect(w.find('.sect').classes()).toContain('closed');
    // collapse is class-driven (.closed .body { display:none }); happy-dom
    // doesn't cascade scoped CSS → assert the CLASS contract, not computed style
    expect(w.find('.sect').classes()).toContain('closed');
    await w.find('h3').trigger('click');
    expect(w.find('.sect').classes()).not.toContain('closed');
  });
  it('renders meta when provided', () => {
    const w = mount(WatcherSection, { props: { title: 'run', meta: '4/7' } });
    expect(w.find('.meta').text()).toBe('4/7');
  });
});

describe('WatcherSteps', () => {
  it('renders state classes and meter', () => {
    const w = mount(WatcherSteps, {
      props: {
        steps: [
          { text: 'arrive home', state: 'done' },
          { text: 'expect list', state: 'live' },
          { text: 'tap result', state: 'todo' },
        ],
        meter: { value: 3, max: 4 },
      },
    });
    const rows = w.findAll('.s');
    expect(rows[0]!.classes()).toContain('done');
    expect(rows[1]!.classes()).toContain('live');
    expect(rows[2]!.classes()).toContain('todo');
    expect(w.find('.meter').text()).toContain('3/4');
    const fill = w.find('.fill').element as HTMLElement;
    expect(fill.style.width).toBe('75%');
  });
});

describe('LogTail', () => {
  it('renders rows with kind classes', () => {
    const w = mount(LogTail, {
      props: { rows: [
        { ts: '09:41:02', text: 'tariff fetched', kind: 'hit' },
        { ts: '09:40:58', text: '499 retry', kind: 'err' },
        { ts: '09:40:55', text: 'scene ready' },
      ] },
    });
    const rows = w.findAll('.logtail > div');
    expect(rows).toHaveLength(3);
    expect(rows[0]!.find('.hit').exists()).toBe(true);
    expect(rows[1]!.find('.err').exists()).toBe(true);
  });
});

describe('SideDrawer', () => {
  it('closed → absent from DOM; open → present + close emits', async () => {
    const shut = mount(SideDrawer, { props: { open: false, title: 'environment' }, slots: { default: '<div class="inner"/>' } });
    expect(shut.find('.drawer').exists()).toBe(false);
    const open = mount(SideDrawer, { props: { open: true, title: 'environment' }, slots: { default: '<div class="inner"/>' } });
    expect(open.find('.inner').exists()).toBe(true);
    expect(open.find('h3').text()).toContain('environment');
    await open.find('.x').trigger('click');
    expect(open.emitted('close')).toHaveLength(1);
  });
});
