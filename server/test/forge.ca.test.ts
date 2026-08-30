/** CA bootstrap contract: a FRESH confdir gets the Apple-compliant hierarchy
 *  (root → intermediate, leaf-only chains are what iOS strict TLS rejects). */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ensureForgeCa } from '../src/forge/sim-routing.ts';

const dir = mkdtempSync(join(tmpdir(), 'forge-ca-test-'));
const confdir = join(dir, 'ca');

afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe('ensureForgeCa (Apple-compliant MITM CA bootstrap)', () => {
  it('fresh confdir → generates root + intermediate + mitmproxy-ca.pem', () => {
    const r = ensureForgeCa(confdir);
    expect(r.created).toBe(true);
    expect(existsSync(join(confdir, 'root.crt'))).toBe(true);
    expect(existsSync(join(confdir, 'int.crt'))).toBe(true);
    const pem = readFileSync(join(confdir, 'mitmproxy-ca.pem'), 'utf8');
    expect((pem.match(/BEGIN CERTIFICATE/g) ?? []).length).toBe(2); // int + root
    expect(pem.includes('BEGIN PRIVATE KEY')).toBe(true); // signing key first
  });

  it('intermediate is signed by the root and is a CA (pathlen 0)', () => {
    const out = execFileSync('openssl', ['verify', '-CAfile', join(confdir, 'root.crt'), join(confdir, 'int.crt')], { encoding: 'utf8' });
    expect(out).toContain('OK');
    const text = execFileSync('openssl', ['x509', '-in', join(confdir, 'int.crt'), '-noout', '-text'], { encoding: 'utf8' });
    expect(text).toContain('CA:TRUE');
    expect(text).toContain('pathlen:0');
  });

  it('idempotent: second call does not regenerate', () => {
    const r = ensureForgeCa(confdir);
    expect(r.created).toBe(false);
  });
});
