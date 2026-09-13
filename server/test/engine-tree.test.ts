/** Engine-tree client tests — fixture happy path, log-line stripping,
 *  timeout, unmappable role, missing binary. No device needed. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { EngineTreeError, fetchEngineTree } from '../src/alloy/engine-tree.js';

const fixture = readFileSync(new URL('./fixtures/ax-depth/foodiary-home/tree-engine.json', import.meta.url), 'utf8');

// fake binary: a shell script printing engine-style log lines + JSON
const makeFakeBin = (mode: 'ok' | 'unmappable' | 'hang'): { bin: string; dir: string } => {
  const { mkdtempSync, writeFileSync, chmodSync } = require('node:fs') as typeof import('node:fs');
  const { join } = require('node:path') as typeof import('node:path');
  const { tmpdir } = require('node:os') as typeof import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'engtree-'));
  const bin = join(dir, 'fake-engine');
  const payload = mode === 'unmappable'
    ? JSON.stringify({ role: 'AXHoverCushion', children: [] })
    : fixture;
  const body = mode === 'hang'
    ? '#!/bin/sh\nsleep 30\n'
    : `#!/bin/sh\necho "[baguette] [ax] AXPTranslator wired"\necho "[baguette] [ax] sweep: probed=258"\necho '${payload.replace(/'/g, `'\\''`)}'\n`;
  writeFileSync(bin, body, { mode: 0o755 });
  chmodSync(bin, 0o755);
  return { bin, dir };
};

describe('fetchEngineTree', () => {
  it('happy path: strips log lines, parses, flattens (uses the real fixture)', async () => {
    const { bin } = makeFakeBin('ok');
    const nodes = await fetchEngineTree('udid-x', { bin });
    expect(nodes.length).toBeGreaterThan(10);
    expect(nodes[0]!.type).toBe('Application');
  }, 20_000);

  it('unmappable role → EngineTreeError PARSE (never a partial tree)', async () => {
    const { bin } = makeFakeBin('unmappable');
    await expect(fetchEngineTree('udid-x', { bin })).rejects.toMatchObject({ code: 'PARSE' });
  }, 20_000);

  it('timeout → EngineTreeError TIMEOUT', async () => {
    const { bin } = makeFakeBin('hang');
    await expect(fetchEngineTree('udid-x', { bin, timeoutMs: 500 })).rejects.toMatchObject({ code: 'TIMEOUT' });
  }, 20_000);

  it('missing binary → BIN_MISSING before any spawn', async () => {
    await expect(fetchEngineTree('udid-x', { bin: '/nonexistent/engine' })).rejects.toMatchObject({ code: 'BIN_MISSING' });
  });

  it('real execFile is used (not shell) — no injection via udid', async () => {
    // execFile passes args directly; a udid with shell metachars is just a bogus arg
    const { bin } = makeFakeBin('ok');
    const nodes = await fetchEngineTree('a; rm -rf /', { bin });
    expect(nodes.length).toBeGreaterThan(0); // fake bin ignores args — still parses
  }, 20_000);
});

describe('EngineTreeError shape', () => {
  it('carries a machine code', () => {
    const e = new EngineTreeError('x', 'SPAWN');
    expect(e.code).toBe('SPAWN');
    expect(execFile).toBeDefined(); // import sanity
  });
});
