/** simdeck supervisor tests — fake binary pattern (a node script serving
 *  /simulators.json 200), mirroring the screenstream supervisor contract.
 *  Env is read at module load, so each test resets the module registry and
 *  re-imports with fresh env. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Supervisor = typeof import('./supervisor.ts');

async function loadSupervisor(): Promise<Supervisor> {
  vi.resetModules();
  return import('./supervisor.ts');
}

function fakeBinDir(): { bin: string } {
  const dir = mkdtempSync(join(tmpdir(), 'simdeck-test-'));
  const bin = join(dir, 'fake-simdeck');
  // a tiny node "binary" that serves /simulators.json on the port in argv
  writeFileSync(bin, `#!/usr/bin/env node
const http = require('node:http');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
const allowed = process.argv.includes('--allowed-hosts');
if (!allowed) { console.error('missing --allowed-hosts'); process.exit(2); }
http.createServer((req, res) => {
  if (req.url === '/simulators.json') { res.writeHead(200, {'content-type':'application/json'}); res.end('{}'); return; }
  res.writeHead(404); res.end();
}).listen(port, '127.0.0.1');
`);
  chmodSync(bin, 0o755);
  return { bin };
}

describe('simdeck supervisor', () => {
  let mod: Supervisor;
  let port = 18420;

  afterEach(async () => {
    mod?.__resetSimdeckForTest();
    mod?.__setSimdeckEnsureForTest(null);
    delete process.env['CRUCIBLE_SIMDECK_BIN'];
    delete process.env['CRUCIBLE_SIMDECK_PORT'];
  });

  it('rejects (permanent class) when the binary is missing', async () => {
    process.env['CRUCIBLE_SIMDECK_BIN'] = '/nonexistent/simdeck-bin';
    process.env['CRUCIBLE_SIMDECK_PORT'] = String(++port);
    mod = await loadSupervisor();
    await expect(mod.ensureSimdeck()).rejects.toThrow(/simdeck binary not found/);
    expect(mod.__simdeckTestState().running).toBe(false);
  });

  it('spawns the binary and resolves the port once healthy', async () => {
    const { bin } = fakeBinDir();
    process.env['CRUCIBLE_SIMDECK_BIN'] = bin;
    process.env['CRUCIBLE_SIMDECK_PORT'] = String(++port);
    mod = await loadSupervisor();
    const p = await mod.ensureSimdeck();
    expect(p).toBe(port);
    expect(mod.__simdeckTestState().running).toBe(true);
    // second ensure reuses the same healthy instance (same promise, no respawn)
    const p2 = await mod.ensureSimdeck();
    expect(p2).toBe(port);
  });

  it('simdeckBase points at the configured port', async () => {
    process.env['CRUCIBLE_SIMDECK_BIN'] = '/nonexistent/simdeck-bin';
    process.env['CRUCIBLE_SIMDECK_PORT'] = String(18999);
    mod = await loadSupervisor();
    expect(mod.simdeckBase()).toBe('http://127.0.0.1:18999');
  });

  it('ensure override seam replaces spawning entirely', async () => {
    mod = await loadSupervisor();
    mod.__setSimdeckEnsureForTest(async () => 12345);
    await expect(mod.ensureSimdeck()).resolves.toBe(12345);
  });
});
