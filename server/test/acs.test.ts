import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanFlowSet } from '../src/domain/acs.ts';

let dir: string;
const T = 'ticket: CUST-1\nac_id: AC-1\nac_text: "does the thing"\ncategory: interaction\nname: x\nsteps: []\n';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crucible-acs-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('scanFlowSet', () => {
  it('parses mapped front-matter', () => {
    writeFileSync(join(dir, 'a.yaml'), T);
    const s = scanFlowSet(dir);
    expect(s.flows).toHaveLength(1);
    expect(s.flows[0]!.mapped).toBe(true);
    expect(s.flows[0]!.ticket).toBe('CUST-1');
    expect(s.flows[0]!.acText).toBe('does the thing');
    expect(s.unmapped).toHaveLength(0);
  });
  it('missing metadata → unmapped (never guessed)', () => {
    writeFileSync(join(dir, 'bare.yaml'), 'name: bare\nsteps: []\n');
    const s = scanFlowSet(dir);
    expect(s.flows[0]!.mapped).toBe(false);
    expect(s.unmapped).toHaveLength(1);
  });
  it('partial metadata → unmapped', () => {
    writeFileSync(join(dir, 'partial.yaml'), 'ticket: CUST-1\nname: p\nsteps: []\n');
    const s = scanFlowSet(dir);
    expect(s.flows[0]!.mapped).toBe(false);
  });
  it('duplicate (ticket|ac) across files → validation error string', () => {
    writeFileSync(join(dir, 'a.yaml'), T);
    writeFileSync(join(dir, 'b.yaml'), T.replace('name: x', 'name: y'));
    const s = scanFlowSet(dir);
    expect(s.duplicateAcError).toContain('AC-1');
  });
  it('same ac from same file name twice (yaml/yml) tolerated by name match', () => {
    writeFileSync(join(dir, 'a.yaml'), T);
    // different flows, same ac → error even with distinct names
    writeFileSync(join(dir, 'c.yaml'), 'ticket: CUST-1\nac_id: AC-1\nac_text: "dup"\ncategory: visual\nname: c\nsteps: []\n');
    const s = scanFlowSet(dir);
    expect(s.duplicateAcError).toBeTruthy();
  });
  it('missing dir throws', () => {
    expect(() => scanFlowSet('/nonexistent/flows')).toThrowError(/not found/);
  });
});
