/** planLanes: duration-greedy case→lane packing (pure). */
import { describe, it, expect } from 'vitest';
import { planLanes } from './plan.ts';

const dev = (udid: string, name = udid) => ({ udid, name });
const tc = (templateId: string, costMs: number) => ({ templateId, costMs });

describe('planLanes (pure planner)', () => {
  it('duration-greedy: heaviest case claims an empty lane; split balances', () => {
    const lanes = planLanes({
      cases: [tc('a', 300), tc('b', 100), tc('c', 100)],
      devices: [dev('d1'), dev('d2')],
    });
    expect(lanes).toHaveLength(2);
    // heaviest (a:300) alone on one lane; b+c (200) share the other
    const loads = lanes.map((l) => l.cases.reduce((s, c) => s + (c.costMs ?? 0), 0)).sort();
    expect(loads).toEqual([200, 300]);
    const all = lanes.flatMap((l) => l.cases.map((c) => c.templateId)).sort();
    expect(all).toEqual(['a', 'b', 'c']);
  });

  it('unknown cost (null) falls back to the default weight deterministically', () => {
    const lanes = planLanes({
      cases: [{ templateId: 'x', costMs: null }, tc('y', 10)],
      devices: [dev('d1'), dev('d2')],
    });
    // default weight (30s) outweighs y(10ms): x alone, y on the other lane
    expect(lanes.map((l) => l.cases.map((c) => c.templateId))).toContainEqual(['x']);
    expect(lanes.map((l) => l.cases.map((c) => c.templateId))).toContainEqual(['y']);
  });

  it('more lanes than cases: empty lanes kept (device still owned by its lane)', () => {
    const lanes = planLanes({ cases: [tc('a', 1)], devices: [dev('d1'), dev('d2'), dev('d3')] });
    expect(lanes).toHaveLength(3);
    expect(lanes.filter((l) => l.cases.length === 0)).toHaveLength(2);
  });

  it('empty cases → empty-case lanes per device (pool still owns devices)', () => {
    const lanes = planLanes({ cases: [], devices: [dev('d1'), dev('d2')] });
    expect(lanes).toHaveLength(2);
    expect(lanes.every((l) => l.cases.length === 0)).toBe(true);
  });

  it('duplicate templateId deduped to first occurrence', () => {
    const lanes = planLanes({ cases: [tc('a', 5), tc('a', 5), tc('b', 5)], devices: [dev('d1')] });
    const ids = lanes.flatMap((l) => l.cases.map((c) => c.templateId));
    expect(ids).toEqual(['a', 'b']);
  });

  it('maxLanes caps the lane count, keeping devices in order', () => {
    const lanes = planLanes({ cases: [tc('a', 1), tc('b', 1)], devices: [dev('d1'), dev('d2'), dev('d3')], maxLanes: 2 });
    expect(lanes).toHaveLength(2);
    expect(lanes.map((l) => l.device.udid)).toEqual(['d1', 'd2']);
  });

  it('deterministic: identical input → identical output across calls', () => {
    const input = { cases: [tc('a', 100), tc('b', 50), tc('c', 50), tc('d', 25)], devices: [dev('d1'), dev('d2'), dev('d3')] };
    expect(planLanes(input)).toEqual(planLanes(input));
  });

  it('equal costs tie-break by templateId (stable, documented)', () => {
    const lanes = planLanes({ cases: [tc('b', 10), tc('a', 10), tc('c', 10)], devices: [dev('d1'), dev('d2'), dev('d3')] });
    const firsts = lanes.map((l) => l.cases[0]?.templateId);
    expect(firsts).toEqual(['a', 'b', 'c']); // sorted asc before greedy
  });
});
