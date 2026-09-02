import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeStateFile } from '../src/forge/mitm/manager.ts';
import type { Preset } from '../src/forge/matcher.ts';

let dir: string;
const presets: Preset[] = [];

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'b1-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('writeStateFile carries activeRunId (B1)', () => {
  it('includes activeRunId when set', () => {
    writeStateFile(dir, 'hybrid', presets, 'run_abc123');
    const data = JSON.parse(readFileSync(join(dir, 'forge-mitm-state.json'), 'utf8')) as { activeRunId?: string | null; mode?: string };
    expect(data.activeRunId).toBe('run_abc123');
    expect(data.mode).toBe('hybrid');
  });

  it('writes null when cleared (run ended)', () => {
    writeStateFile(dir, 'hybrid', presets, 'run_abc123');
    writeStateFile(dir, 'hybrid', presets, null);
    const data = JSON.parse(readFileSync(join(dir, 'forge-mitm-state.json'), 'utf8')) as { activeRunId?: string | null };
    expect(data.activeRunId).toBeNull();
  });

  it('defaults to null when omitted (legacy call sites keep old semantics: no run active)', () => {
    writeStateFile(dir, 'record', presets);
    const data = JSON.parse(readFileSync(join(dir, 'forge-mitm-state.json'), 'utf8')) as { activeRunId?: string | null };
    expect(data.activeRunId).toBeNull();
  });
});

describe('writeStateFile atomicity (B4a)', () => {
  it('leaves no .tmp file behind after write', () => {
    writeStateFile(dir, 'hybrid', presets, 'run_x');
    const leftovers = readdirSync(dir).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('a concurrent reader never observes torn JSON (interleaved writes)', async () => {
    const stop = { flag: false };
    const reader = (async () => {
      while (!stop.flag) {
        try {
          const raw = readFileSync(join(dir, 'forge-mitm-state.json'), 'utf8');
          JSON.parse(raw); // must ALWAYS parse — torn write = parse failure
        } catch (e) {
          if ((e as Error).message.includes('Unexpected')) throw e; // torn, not absent
        }
        await new Promise((r) => setTimeout(r, 1));
      }
    })();
    for (let i = 0; i < 60; i++) {
      writeStateFile(dir, 'hybrid', presets, `run_${i}`);
      await new Promise((r) => setTimeout(r, 2));
    }
    stop.flag = true;
    await reader; // throws if any torn read occurred
  });
});
