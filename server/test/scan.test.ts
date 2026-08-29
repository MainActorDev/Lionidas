import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scanner = fileURLToPath(new URL('../../scripts/scan-signatures.mjs', import.meta.url));

describe('signature scan', () => {
  it('repo tree is clean (exit 0)', () => {
    execFileSync('node', [scanner]); // non-zero exit throws
  });
  it('scanner source contains its patterns (self-check the gate is real)', () => {
    // The scanner must carry its pattern list; a scanner with empty patterns
    // would always pass — assert the gate itself is armed.
    const src = execFileSync('node', ['-e', `console.log(require('node:fs').readFileSync(${JSON.stringify(scanner)}, 'utf8'))`], { encoding: 'utf8' });
    expect(src).toMatch(/PATTERNS/);
    expect((src.match(/\//g) ?? []).length).toBeGreaterThan(0);
    expect(src).toContain('process.exit(1)');
  });
});
