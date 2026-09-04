import { describe, it, expect } from 'vitest';
import { buildCompletions, type EditorVocabulary } from '@crucible/shared/yaml-completions';
import { yamlQuote } from '@crucible/shared/yaml-quote';

const vocab: EditorVocabulary = {
  selectors: [
    { value: 'Beranda', kind: 'label', uses: 3, cases: ['tnc', 'scan'] },
    { value: 'ic_barcode', kind: 'identifier', uses: 1, cases: ['scan'] },
  ],
  caseNames: ['tnc', 'login-flow'],
  apps: ['com.lioparcel.services.consumer.int-dev'],
  tags: ['smoke', 'regression'],
};

describe('buildCompletions', () => {
  it('top-key offers the four top-level keys with detail text', () => {
    const cs = buildCompletions('top-key', vocab, '');
    expect(cs.map((c) => c.label)).toEqual(['name', 'tags', 'app', 'steps']);
    expect(cs.every((c) => c.detail)).toBe(true);
  });

  it('step-action offers skeletons with placeholders', () => {
    const cs = buildCompletions('step-action', vocab, '');
    const tap = cs.find((c) => c.label === 'tap')!;
    expect(String(tap.apply)).toContain('point: [');
    expect(String(tap.apply)).toContain('on: ');
    expect(cs.map((c) => c.label)).toEqual(['tap', 'scroll', 'type', 'runFlow', 'expect']);
  });

  it('direction offers exactly the four directions', () => {
    expect(buildCompletions('direction', vocab, '').map((c) => c.label)).toEqual(['up', 'down', 'left', 'right']);
  });

  it('body-key for tap offers point/on/optional (no text)', () => {
    expect(buildCompletions('body-key', vocab, '', 'tap').map((c) => c.label)).toEqual(['point', 'on', 'optional']);
  });
  it('body-key for type adds text', () => {
    expect(buildCompletions('body-key', vocab, '', 'type').map((c) => c.label)).toEqual(['point', 'text', 'on', 'optional']);
  });
  it('body-key for expect offers on/optional only', () => {
    expect(buildCompletions('body-key', vocab, '', 'expect').map((c) => c.label)).toEqual(['on', 'optional']);
  });
  it('body-key for runFlow offers name/optional only', () => {
    expect(buildCompletions('body-key', vocab, '', 'runFlow').map((c) => c.label)).toEqual(['name', 'optional']);
  });
  it('body-key without action defaults to the tap set (safest common case)', () => {
    expect(buildCompletions('body-key', vocab, '').map((c) => c.label)).toEqual(['point', 'on', 'optional']);
  });

  it('on-value: label = raw value, apply = yamlQuote(value), detail carries kind + uses + cases', () => {
    const cs = buildCompletions('on-value', vocab, 'Be');
    const ber = cs.find((c) => c.label === 'Beranda')!;
    expect(ber.apply).toBe(yamlQuote('Beranda'));
    expect(ber.detail).toContain('label');
    expect(ber.detail).toContain('3');
    expect(ber.detail).toContain('tnc');
  });

  it('on-value quotes yaml-hostile labels on apply', () => {
    const v2: EditorVocabulary = { ...vocab, selectors: [{ value: 'Masuk: Daftar', kind: 'label', uses: 1, cases: ['x'] }] };
    const c = buildCompletions('on-value', v2, 'Masuk').find((x) => x.label.includes('Masuk'))!;
    expect(c.apply).toBe(yamlQuote('Masuk: Daftar'));   // quoted — validator-safe
  });

  it('runflow-name offers case names quoted; app-value offers bundle ids; tag-value offers tags', () => {
    expect(buildCompletions('runflow-name', vocab, '').map((c) => c.apply)).toEqual(vocab.caseNames.map(yamlQuote));
    expect(buildCompletions('app-value', vocab, '').map((c) => c.label)).toEqual(vocab.apps);
    expect(buildCompletions('tag-value', vocab, '').map((c) => c.label)).toEqual(vocab.tags);
  });

  it('empty vocabulary → value slots return [] (grammar slots unaffected)', () => {
    const empty: EditorVocabulary = { selectors: [], caseNames: [], apps: [], tags: [] };
    expect(buildCompletions('on-value', empty, '')).toEqual([]);
    expect(buildCompletions('direction', empty, '').length).toBe(4);
    expect(buildCompletions('step-action', empty, '').length).toBe(5);
  });

  it('none slot → [] always', () => {
    expect(buildCompletions('none', vocab, '')).toEqual([]);
  });
});
