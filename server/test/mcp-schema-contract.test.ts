/** ALL-tools param-type contract test (brainstorm 20261014T195000Z):
 *  spawns the REAL MCP server (mcp-stdio.sh — the exact boundary the claude
 *  CLI talks to), lists every tool, and for every array/object/boolean
 *  parameter round-trips a representative value; asserts the response is
 *  NEVER a -32602 type rejection (the sess_e2e40228 bug: array params were
 *  coerced to string at the zod seam and died before the tool ran —
 *  screens, suite members, seq rules, templateIds were ALL dead over MCP).
 *
 *  This pins the INTERFACE matrix — every tool × every param type — the same
 *  discipline the interaction matrix applied to user journeys. */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = join(HERE, '..');

interface JsonRpc { id?: number; result?: { tools?: Array<{ name: string; inputSchema?: Record<string, unknown> }> }; error?: { message?: string } }
interface Pending { resolve: (v: JsonRpc) => void }

let child: ChildProcess;
let seq = 0;
const pending = new Map<number, Pending>();
let buf = '';

function send(method: string, params?: unknown): Promise<JsonRpc> {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve });
    child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) }) + '\n');
    // initialize pays the cold-start (tsx transform + module graph) — on a fresh CI
  // runner that alone can eat 20s; tool calls stay at the normal budget.
  const budget = method === 'initialize' ? 90_000 : 20_000;
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`jsonrpc timeout: ${method}`)); } }, budget);
  });
}
function notify(method: string, params?: unknown): void {
  child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) }) + '\n');
}

function sampleValue(p: Record<string, unknown>): unknown {
  const t = p['type'];
  if (Array.isArray(p['enum'])) return (p['enum'] as unknown[])[0];
  if (t === 'string') return 'probe';
  if (t === 'number') return 1;
  if (t === 'boolean') return true;
  if (t === 'array') return [sampleValue((p['items'] as Record<string, unknown>) ?? { type: 'string' })];
  if (t === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, sub] of Object.entries((p['properties'] ?? {}) as Record<string, Record<string, unknown>>)) out[k] = sampleValue(sub);
    return out;
  }
  return null;
}

beforeAll(async () => {
  child = spawn('/bin/bash', [join(SERVER_DIR, 'src/agent/mcp-stdio.sh')], { cwd: SERVER_DIR, stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, VITEST: 'true' } });
  child.stdout!.on('data', (chunk: Buffer) => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as JsonRpc;
        if (msg.id !== undefined) pending.get(msg.id)?.resolve(msg);
      } catch { /* partial */ }
    }
  });
  await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'contract-probe', version: '1' } });
  notify('notifications/initialized');
}, 150_000);
// ^ hook budget: the initialize inside pays cold tsx transform on a fresh CI runner
// (observed >30s on macos-latest); 150s hook + 90s per-call initialize budget.
afterAll(() => { child.kill(); rmSync(join(tmpdir(), 'mcp-contract-db'), { recursive: true, force: true }); });

describe('interface matrix: every tool × every non-string param type crosses the MCP boundary', () => {
  it('tools/list exposes the registry', async () => {
    const r = await send('tools/list');
    const tools = r.result?.tools ?? [];
    expect(tools.length).toBeGreaterThan(30);
  }, 30_000);

  it('NO tool param of array/object/boolean type is rejected as a type mismatch (-32602)', async () => {
    const list = await send('tools/list');
    const tools = list.result?.tools ?? [];
    const offenders: string[] = [];
    const probes: Array<{ tool: string; args: Record<string, unknown> }> = [];
    for (const tool of tools) {
      const props = ((tool.inputSchema?.['properties'] ?? {}) as Record<string, Record<string, unknown>>);
      const args: Record<string, unknown> = {};
      let hasTyped = false;
      for (const [name, p] of Object.entries(props)) {
        const t = String(p['type'] ?? '');
        if (['array', 'object', 'boolean'].includes(t)) { args[name] = sampleValue(p); hasTyped = true; }
        else if (t === 'string') args[name] = 'probe';
        else if (t === 'number') args[name] = 1;
      }
      if (hasTyped) probes.push({ tool: tool.name, args });
    }
    expect(probes.length).toBeGreaterThan(5); // screens/members/seq/moves surfaces are covered
    for (const probe of probes) {
      const r = await send('tools/call', { name: probe.tool, arguments: probe.args });
      const err = r.error?.message ?? '';
      const isTypeReject = err.includes('Invalid input') || err.includes('expected');
      if (isTypeReject) offenders.push(`${probe.tool}: ${err.slice(0, 120)}`);
    }
    expect(offenders).toEqual([]);
  }, 120_000);
});
