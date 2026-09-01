import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
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
