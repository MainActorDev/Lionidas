import { describe, expect, it } from 'vitest';
import { stepLabel } from '../src/manual/playback.ts';
import type { PlaybackStep } from '../src/manual/playback.ts';

/** Plan labels must be honest (operator 2026-10-04: 'type \"\"' and 'expect ?'
 *  in the watch pane): contains-matchers are legal selector hints, run-time
 *  text shows a redaction marker, never an empty string or bare '?'. */

const step = (s: Partial<PlaybackStep>): PlaybackStep => ({ idx: 0, action: 'tap', ...s }) as PlaybackStep;

describe('stepLabel', () => {
  it('expect falls back to labelContains (was: expect ?)', () => {
    expect(stepLabel(step({ action: 'expect', selector: { labelContains: 'DATA COLLECTION' } as never }))).toBe('expect DATA COLLECTION');
  });
  it('expect with identifier still works', () => {
    expect(stepLabel(step({ action: 'expect', selector: { identifier: 'legal_doc_privacy_screen' } as never }))).toBe('expect legal_doc_privacy_screen');
  });
  it('type with run-time-resolved/empty text shows the redaction marker (was: type "")', () => {
    expect(stepLabel(step({ action: 'type' }))).toBe('type •••');
    expect(stepLabel(step({ action: 'type', text: '' }))).toBe('type •••');
  });
  it('type with a literal keeps it, with the target hint when a selector exists', () => {
    expect(stepLabel(step({ action: 'type', text: '0812' }))).toBe('type "0812"');
    expect(stepLabel(step({ action: 'type', text: '0812', selector: { identifier: 'phone_field' } as never }))).toBe('type "0812" → phone_field');
  });
  it('tap uses the selector ladder identifier → label → labelContains', () => {
    expect(stepLabel(step({ action: 'tap', selector: { identifier: 'ic_tabbar_account_inactive' } as never }))).toBe('tap ic_tabbar_account_inactive');
    expect(stepLabel(step({ action: 'tap', selector: { label: 'Privacy Policy' } as never }))).toBe('tap Privacy Policy');
  });
  it('ensureLogin/ensureLogout read as English', () => {
    expect(stepLabel(step({ action: 'ensureLogin' }))).toBe('ensure logged in');
    expect(stepLabel(step({ action: 'ensureLogout' }))).toBe('ensure logged out');
  });
});
