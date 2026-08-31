import { describe, it, expect } from 'vitest';
import { expandFlows } from '../src/manual/flows.ts';

const TPLS: Record<string, { name: string; steps: Array<Record<string, unknown>> }> = {
  login: { name: 'login', steps: [{ idx: 0, action: 'tap', x: 1, y: 1 }, { idx: 1, action: 'type', x: 2, y: 2, text: 'a' }] },
  home: { name: 'home-check', steps: [{ idx: 0, action: 'runFlow', templateId: 'login' }, { idx: 1, action: 'scroll', direction: 'up' }] },
  wrap: { name: 'wrap', steps: [{ idx: 0, action: 'runFlow', templateId: 'home', optional: true }] },
  self: { name: 'self', steps: [{ idx: 0, action: 'runFlow', templateId: 'self' }] },
};
const load = (id: string) => TPLS[id] ?? null;

describe('expandFlows', () => {
  it('inlines child steps, tags them with child flow name, renumbers', () => {
    const out = expandFlows(TPLS['home']!.steps as never, load);
    expect(out.map((s) => [s.idx, s.flow])).toEqual([[0, 'login'], [1, 'login'], [2, undefined]]);
  });
  it('non-runFlow steps pass through untouched', () => {
    const out = expandFlows(TPLS['login']!.steps as never, load);
    expect(out[0]).toEqual({ idx: 0, action: 'tap', x: 1, y: 1 });
  });
  it('optional runFlow marks child steps optional', () => {
    const out = expandFlows(TPLS['wrap']!.steps as never, load);
    expect(out.every((s) => s.optional === true)).toBe(true);
    expect(out.every((s) => typeof s.flow === 'string')).toBe(true);
  });
  it('cycles throw', () => {
    expect(() => expandFlows(TPLS['self']!.steps as never, load)).toThrow(/cycle/);
  });
  it('missing template throws', () => {
    expect(() => expandFlows([{ idx: 0, action: 'runFlow', templateId: 'nope' }] as never, load)).toThrow(/not found/);
  });
  it('same subflow twice (not a cycle) is allowed', () => {
    const out = expandFlows([{ idx: 0, action: 'runFlow', templateId: 'login' }, { idx: 1, action: 'runFlow', templateId: 'login' }] as never, load);
    expect(out).toHaveLength(4);
  });
  it('depth > 5 throws', () => {
    const deep: Record<string, { name: string; steps: Array<Record<string, unknown>> }> = {};
    for (let i = 0; i < 8; i++) deep[`t${i}`] = { name: `t${i}`, steps: [{ idx: 0, action: 'runFlow', templateId: `t${i + 1}` }] };
    deep['t8'] = { name: 't8', steps: [{ idx: 0, action: 'tap', x: 0, y: 0 }] };
    expect(() => expandFlows(deep['t0']!.steps as never, (id) => deep[id] ?? null)).toThrow(/nesting/);
  });
});
