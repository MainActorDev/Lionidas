import { describe, it, expect } from 'vitest';
import { captureSelectorAt, resolveSelector, countMatches } from '../src/manual/selector.ts';

const NODES = [
  { index: 0, type: 'Application', label: 'Lion Parcel', rect: { x: 0, y: 0, width: 428, height: 926 } },
  { index: 1, parentIndex: 0, type: 'Other', label: 'Home', rect: { x: 0, y: 0, width: 428, height: 926 }, hittable: true },
  { index: 2, parentIndex: 1, type: 'Button', label: 'Sign In', rect: { x: 20, y: 100, width: 120, height: 44 }, hittable: true },
  { index: 3, parentIndex: 1, type: 'Image', identifier: 'ic_barcode', rect: { x: 350, y: 60, width: 28, height: 28 }, hittable: true },
  { index: 4, parentIndex: 1, type: 'Other', label: 'Sign In', rect: { x: 20, y: 100, width: 120, height: 44 }, hittable: true }, // duplicate label, diff type
  { index: 5, parentIndex: 1, type: 'Other', rect: { x: 0, y: 200, width: 428, height: 60 }, hittable: true }, // no label/id — parent has one
  { index: 6, parentIndex: 1, type: 'Other', label: 'Banner', rect: { x: 0, y: 200, width: 428, height: 60 } },
];

describe('captureSelectorAt', () => {
  it('captures label+type of deepest hittable node at point', () => {
    expect(captureSelectorAt(NODES, 80, 122)).toEqual({ label: 'Sign In', type: 'Button' });
  });
  it('captures identifier when present (icons)', () => {
    const sel = captureSelectorAt(NODES, 364, 74);
    expect(sel?.identifier).toBe('ic_barcode');
  });
  it('walks to parent when hit node has no label/identifier', () => {
    // node 5 (Other, no label) → parent chain via parentIndex leads to node 1
    // 'Home' (428×926 screen container — now REJECTED by the container guard,
    // same class as the app root: coordinate fallback is more precise).
    // Regression note: pre-guard this captured {label:'Home'} and playback
    // redirected taps to the screen center.
    expect(captureSelectorAt(NODES, 200, 230)).toBeNull();
  });
  it('returns null when nothing hittable contains the point', () => {
    expect(captureSelectorAt(NODES, -5, -5)).toBeNull();
  });
  it('container guard: never captures the app root / screen-sized ancestor', () => {
    // tap lands on unlabeled chrome deep in the hierarchy; the walk would
    // climb to node 0 (Application, screen-sized) — the guard must refuse
    // and let playback use the recorded coordinates instead
    const sel = captureSelectorAt(NODES, 10, 10);
    expect(sel).toBeNull();
  });
});

describe('resolveSelector', () => {
  it('resolves unique hittable match to rect center (rect included for proximity check)', () => {
    expect(resolveSelector(NODES, { label: 'Sign In', type: 'Button' })).toEqual({ x: 80, y: 122, rect: { x: 20, y: 100, width: 120, height: 44 } });
  });
  it('resolves by identifier alone', () => {
    expect(resolveSelector(NODES, { identifier: 'ic_barcode' })).toEqual({ x: 364, y: 74, rect: { x: 350, y: 60, width: 28, height: 28 } });
  });
  it('returns null on ambiguous (2+ matches)', () => {
    // label-only: matches node 2 (Button) AND node 4 (Other) → ambiguous
    expect(resolveSelector(NODES, { label: 'Sign In' })).toBeNull();
  });
  it('returns null when gone (no match)', () => {
    expect(resolveSelector(NODES, { label: 'Deleted' })).toBeNull();
  });
  it('container guard: legacy screen-sized selector resolves to nothing (coordinate fallback wins)', () => {
    // tnc-style legacy template: {label:'Lion Parcel', type:'Application'} —
    // resolving it would tap the app-root CENTER, far from the recorded point
    expect(resolveSelector(NODES, { label: 'Lion Parcel', type: 'Application' })).toBeNull();
  });
});

describe('countMatches (expect assertions)', () => {
  it('SwiftUI same-rect duplicate exposure (container + StaticText, identical label+rect) collapses to ONE', () => {
    const nodes = [
      { type: 'Other', label: 'II. DATA COLLECTION', rect: { x: 36, y: 378.7, width: 358, height: 47.7 } },
      { type: 'StaticText', label: 'II. DATA COLLECTION', rect: { x: 36, y: 378.7, width: 358, height: 17 } },
    ];
    // live-measured shape from the LP privacy-policy screen: same x/y, the
    // child height differs — dedup must key on x,y (top-left), not full rect
    expect(countMatches(nodes, { label: 'II. DATA COLLECTION' })).toBe(1);
  });

  it('genuinely distinct occurrences at different positions stay ambiguous', () => {
    const nodes = [
      { type: 'StaticText', label: 'Lion Parcel Consumer App Privacy Policy', rect: { x: 0, y: 60, width: 300, height: 20 } },
      { type: 'StaticText', label: 'Lion Parcel Consumer App Privacy Policy', rect: { x: 36, y: 200, width: 300, height: 20 } },
    ];
    expect(countMatches(nodes, { label: 'Lion Parcel Consumer App Privacy Policy' })).toBe(2);
  });

  it('single node counts 1; zero counts 0', () => {
    expect(countMatches([{ type: 'StaticText', label: 'A', rect: { x: 1, y: 1, width: 5, height: 5 } }], { label: 'A' })).toBe(1);
    expect(countMatches([], { label: 'A' })).toBe(0);
  });
});
