import { describe, it, expect } from 'vitest';
import { slotAt } from '@crucible/shared/yaml-slots';
import { yamlQuote } from '@crucible/shared/yaml-quote';
import { yamlQuote as q2 } from '@crucible/shared/yaml-quote';

describe('slotAt', () => {
  it('top-level key slot at column 0 of an empty/new doc region', () => {
    const y = 'name: x\nsteps:\n';
    expect(slotAt(y, y.length)).toBe('top-key');   // empty line after steps:
    expect(slotAt('name: x\nst', 9)).toBe('top-key');  // typing "st" at top level
    expect(slotAt('', 0)).toBe('top-key');
  });

  it('step-action slot right after "- "', () => {
    const y = 'steps:\n  - ';
    expect(slotAt(y, y.length)).toBe('step-action');
  });

  it('direction slot after "scroll: "', () => {
    const y = 'steps:\n  - scroll: ';
    expect(slotAt(y, y.length)).toBe('direction');
  });

  it('body-key slot inside a tap mapping, typing a key name', () => {
    const y = 'steps:\n  - tap: { po';
    expect(slotAt(y, y.length)).toBe('body-key');
  });

  it('on-value slot after "on: "', () => {
    const y = 'steps:\n  - tap: { point: [1, 2], on: Be';
    expect(slotAt(y, y.length)).toBe('on-value');
  });

  it('runFlow name slot', () => {
    const y = 'steps:\n  - runFlow: { name: lo';
    expect(slotAt(y, y.length)).toBe('runflow-name');
  });

  it('app slot after "app: "', () => {
    const y = 'name: x\napp: com.l';
    expect(slotAt(y, y.length)).toBe('app-value');
  });

  it('tag slot inside tags: [...]', () => {
    const y = 'name: x\ntags: [smo';
    expect(slotAt(y, y.length)).toBe('tag-value');
  });

  it('quoted on-value: cursor inside the quotes still completes', () => {
    const y = "steps:\n  - expect: { on: 'Ber";
    expect(slotAt(y, y.length)).toBe('on-value');
  });

  it('text slot after "text: " → no vocabulary (free text)', () => {
    const y = 'steps:\n  - type: { text: hun';
    expect(slotAt(y, y.length)).toBe('none');
  });

  it('scalar expect (no braces) after "- expect: "', () => {
    const y = 'steps:\n  - expect: Ber';
    expect(slotAt(y, y.length)).toBe('on-value');
  });

  it('contains-value slot after "contains: "', () => {
    const y = "steps:\n  - expect: { contains: DATA";
    expect(slotAt(y, y.length)).toBe('contains-value');
  });
  it('contains-value inside quotes', () => {
    const y = "steps:\n  - expect: { contains: 'DATA";
    expect(slotAt(y, y.length)).toBe('contains-value');
  });

  it('free text after "name: " top-level → none (arbitrary case names)', () => {
    const y = 'name: tn';
    expect(slotAt(y, y.length)).toBe('none');
  });

  it('completed tap line with closed braces → none', () => {
    const y = 'steps:\n  - tap: { point: [1, 2], on: Beranda }';
    expect(slotAt(y, y.length)).toBe('none');
  });

  it('multi-step doc: classification is per-line, later steps classify independently', () => {
    const y = 'name: x\nsteps:\n  - tap: { point: [1, 2] }\n  - scroll: down\n  - ex';
    expect(slotAt(y, y.length)).toBe('step-action');
  });

  it('expect mapping with optional already present, typing on value', () => {
    const y = "steps:\n  - expect: { optional: true, on: Ber";
    expect(slotAt(y, y.length)).toBe('on-value');
  });

  it('cursor mid-line: only text before the cursor classifies', () => {
    const y = 'steps:\n  - tap: { point: [1, 2], on: Beranda, text: x }';
    expect(slotAt(y, y.indexOf('Beranda'))).toBe('on-value');  // before typing the value
  });
});

describe('yamlQuote (re-exported from case-yaml)', () => {
  it('quotes exactly like the serializer would', () => {
    expect(yamlQuote('Beranda')).toBe('Beranda');
    // NOTE: by the serializer's own rules this label is PLAIN-SAFE (no yaml
    // metachars) — the serializer emits it unquoted too. Quote-triggering
    // examples: colon, leading dash, bool-lookalike, embedded quote.
    expect(yamlQuote('Log in to get the best shipping rates.')).toBe('Log in to get the best shipping rates.');
    expect(yamlQuote('Masuk: Daftar')).toBe("'Masuk: Daftar'");
    expect(yamlQuote('- dashed')).toBe("'- dashed'");
    expect(yamlQuote('ic_barcode')).toBe('ic_barcode');
    expect(yamlQuote('true')).toBe("'true'");   // looks like a bool → quoted
    expect(yamlQuote('')).toBe("''");
    expect(yamlQuote('It\'s here')).toBe("'It''s here'");   // quote doubling
    expect(yamlQuote).toBe(q2);   // the re-export IS the same function — no drift possible
  });
});
