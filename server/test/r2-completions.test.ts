import { describe, it, expect } from 'vitest';
import { slotAt } from '@crucible/shared/yaml-slots';
import { buildCompletions, type EditorVocabulary } from '@crucible/shared/yaml-completions';

/** Registry-UI stage 1 — R2 verb completions. Pins:
 *  - two-word action parsing (review F4): `expect screen:` must classify as
 *    screen-state, NOT fall into the scalar-expect on-value branch; scalar
 *    `expect:` behavior unchanged
 *  - arrive/refresh/swap slots classify after their colons
 *  - completions: screens with bundles (review F2 — scoping data present),
 *    screen.state pairs, swap targets from variant ids
 *  - degradation: absent screens vocab → empty lists, never errors */

const VOCAB: EditorVocabulary = {
  selectors: [],
  caseNames: [],
  apps: ['com.a.app', 'com.b.app'],
  tags: [],
  scenarios: ['countries-sg'],
  variantIds: ['sg', 'my'],
  screens: [
    { screen: 'home', bundle: 'com.a.app', states: ['world-sg', 'loaded'] },
    { screen: 'home', bundle: 'com.b.app', states: ['ready'] }, // same id, other bundle — F2 fixture
    { screen: 'tarif-form', bundle: 'com.a.app', states: ['open'] },
  ],
};

describe('slotAt — R2 verb lines (F4: two-word actions)', () => {
  const doc = (line: string) => `name: x\nsteps:\n  ${line}`;
  const at = (line: string, off: number) => slotAt(doc(line), doc(line).length - off);

  it('expect screen: classifies as screen-state (not scalar expect)', () => {
    expect(at('- expect screen: home.', 0)).toBe('screen-state');
    expect(at('- expect screen: ', 0)).toBe('screen-state');
  });
  it('scalar expect: still classifies as on-value (no regression)', () => {
    expect(at('- expect: Some Label', 0)).toBe('on-value');
  });
  it('arrive/refresh classify as arrive-screen', () => {
    expect(at('- arrive: ho', 0)).toBe('arrive-screen');
    expect(at('- refresh: ', 0)).toBe('arrive-screen');
  });
  it('swap classifies as swap-target', () => {
    expect(at('- swap: m', 0)).toBe('swap-target');
  });
  it('partial two-word action typing ("expect scre" no colon) stays step-action', () => {
    expect(at('- expect scre', 0)).toBe('step-action');
    expect(at('- expect screen', 0)).toBe('step-action');
  });
});

describe('buildCompletions — new slots', () => {
  it('arrive-screen lists screens with bundle detail (F2 data)', () => {
    const out = buildCompletions('arrive-screen', VOCAB, '');
    expect(out.map((c) => c.label)).toEqual(['home', 'home', 'tarif-form']);
    expect(out[0]!.detail).toBe('screen · com.a.app');
    expect(out[1]!.detail).toBe('screen · com.b.app'); // same id distinguished by bundle
  });
  it('screen-state lists screen.state pairs', () => {
    const out = buildCompletions('screen-state', VOCAB, '');
    expect(out.map((c) => c.label)).toContain('home.world-sg');
    expect(out.map((c) => c.label)).toContain('home.ready'); // bundle-b sibling state
    expect(out.map((c) => c.label)).toContain('tarif-form.open');
  });
  it('swap-target comes from variant ids (swaps ∪ variants share storage)', () => {
    const out = buildCompletions('swap-target', VOCAB, '');
    expect(out.map((c) => c.label)).toEqual(['sg', 'my']);
  });
  it('step-action skeletons include the R2 verbs', () => {
    const out = buildCompletions('step-action', VOCAB, '');
    expect(out.map((c) => c.label)).toContain('arrive');
    expect(out.map((c) => c.label)).toContain('swap');
    expect(out.map((c) => c.label)).toContain('expect screen');
  });
  it('degradation: absent screens vocab → empty lists, no throw (old servers)', () => {
    const bare: EditorVocabulary = { selectors: [], caseNames: [], apps: [], tags: [] };
    expect(buildCompletions('arrive-screen', bare, '')).toEqual([]);
    expect(buildCompletions('screen-state', bare, '')).toEqual([]);
  });
});
