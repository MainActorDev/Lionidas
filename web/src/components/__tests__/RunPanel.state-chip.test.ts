/** Phase B S4 — provenance chip on run steps: ensureState steps audit
 *  {stateId, revision, path, probeMs} in evaluated_json; the RunPanel row
 *  shows WHICH state revision the run converged with and HOW (probe-hit ↷
 *  green = idempotent skip; recipe → steel = the walk ran). */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import RunPanel from '../RunPanel.vue';

function stubFetch(steps: Array<Record<string, unknown>>): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
    ok: true,
    json: async () => {
      if (String(url).includes('/steps')) return { steps };
      return { run: { id: 'run_p1', status: 'passed', started_at: 1, finished_at: 2, blocked: 0, note: '' } };
    },
  })) as unknown as typeof fetch);
}

const PROPS = { runId: 'run_p1', templateId: 'tpl_x', caseName: 'Case X', udid: 'SIM-1' };

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('RunPanel — state provenance chip', () => {
  it('renders the chip for an ensureState step (id · revision · path)', async () => {
    stubFetch([
      { idx: 0, flow_name: null, name: 'ensure state', status: 'pass', reason: null, duration_ms: 4402, narrate: null, evaluated_json: JSON.stringify({ action: 'ensureState', stateId: 'fresh_install', revision: 1, path: 'probe-hit', probeMs: 4402 }) },
      { idx: 1, flow_name: null, name: 'expect', status: 'pass', reason: null, duration_ms: 12, narrate: null, evaluated_json: JSON.stringify({ action: 'expect', selector: { identifier: 'x' } }) },
    ]);
    const w = mount(RunPanel, { props: PROPS, global: { config: { warnHandler: () => {} } } });
    await flushPromises();
    const chip = w.find('.rp-state');
    expect(chip.exists()).toBe(true);
    expect(chip.text()).toContain('fresh_install · r1');
    expect(chip.classes()).toContain('probe-hit');
    expect(chip.attributes('title')).toContain('revision 1');
    expect(chip.attributes('title')).toContain('probe 4402ms');
    // the plain expect step carries no chip
    const chips = w.findAll('.rp-state');
    expect(chips).toHaveLength(1);
  });

  it('recipe-path chips render the walk glyph, probe-hit the skip glyph', async () => {
    stubFetch([
      { idx: 0, flow_name: null, name: 'ensure state', status: 'pass', reason: null, duration_ms: 9300, narrate: null, evaluated_json: JSON.stringify({ action: 'ensureState', stateId: 'on_profile_setup', revision: 3, path: 'recipe', stepsPlayed: 1 }) },
    ]);
    const w = mount(RunPanel, { props: PROPS, global: { config: { warnHandler: () => {} } } });
    await flushPromises();
    const chip = w.find('.rp-state');
    expect(chip.text()).toContain('on_profile_setup · r3');
    expect(chip.find('.rp-state-glyph').text()).toBe('→');
    expect(chip.classes()).not.toContain('probe-hit');
  });

  it('forced resets render the ⟳ glyph, forced class, and no probe timing', async () => {
    stubFetch([
      { idx: 0, flow_name: null, name: 'ensure state', status: 'pass', reason: null, duration_ms: 9900, narrate: null, evaluated_json: JSON.stringify({ action: 'ensureState', stateId: 'fresh_install', revision: 2, path: 'forced', forced: true, stepsPlayed: 1 }) },
    ]);
    const w = mount(RunPanel, { props: PROPS, global: { config: { warnHandler: () => {} } } });
    await flushPromises();
    const chip = w.find('.rp-state');
    expect(chip.text()).toContain('fresh_install · r2');
    expect(chip.find('.rp-state-glyph').text()).toBe('⟳');
    expect(chip.classes()).toContain('forced');
    expect(chip.attributes('title')).toContain('forced (recipe always runs');
    expect(chip.attributes('title')).not.toContain('probe ');
  });

  it('no chip on steps without an ensureState audit (null/garbage evaluated_json)', async () => {
    stubFetch([
      { idx: 0, flow_name: null, name: 'tap', status: 'pass', reason: null, duration_ms: 5, narrate: null, evaluated_json: null },
      { idx: 1, flow_name: null, name: 'expect', status: 'pass', reason: null, duration_ms: 5, narrate: null, evaluated_json: '{not json' },
    ]);
    const w = mount(RunPanel, { props: PROPS, global: { config: { warnHandler: () => {} } } });
    await flushPromises();
    expect(w.find('.rp-state').exists()).toBe(false);
  });
});
