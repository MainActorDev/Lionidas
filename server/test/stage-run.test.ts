/** stage.run (plan 20261013T162000Z): the model-called stage executor. */

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ToolRegistry, SqliteStorage, StorageRetriever } from '@mainactordev/butler';
import { registerStageRunTool } from '../src/agent/stage-run.ts';
import { buildToolRegistry } from '../src/agent/tools.ts';
import { COMMANDS } from '../src/agent/commands.ts';

let dir: string;
let db: Database.Database;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'stage-run-'));
  db = new Database(':memory:');
});
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

function mkCtx(provider: unknown): Parameters<typeof registerStageRunTool>[1] {
  const storage = new SqliteStorage(':memory:');
  const retriever = new StorageRetriever(storage);
  const registry = buildToolRegistry({ db, storage, retriever, artifactsDir: dir });
  registerStageRunTool(registry, { db, storage, retriever, registry, provider: provider as never, policy: {} as never, systemPrompt: '', artifactsDir: dir, seedPromise: Promise.resolve({ documents: 0, skipped: 0 }) } as never, {});
  return { registry } as never;
}

describe('stage.run tool', () => {
  it('rejects unknown commands and empty input honestly', async () => {
    const { registry } = mkCtx({}) as unknown as { registry: ToolRegistry };
    const t = registry.get('stage.run')!;
    expect(String(await t.execute({ command: '/nope', input: 'x' }, { sessionId: 't', signal: undefined }))).toContain('unknown command');
    expect(String(await t.execute({ command: '/planning', input: '  ' }, { sessionId: 't', signal: undefined }))).toContain('input required');
  });

  it('runs an isolated stage: registry instructions as the child prompt, output returned (mock provider)', async () => {
    const seenPrompts: string[] = [];
    const provider = {
      async complete(messages: Array<{ role: string; content: string | null }>) {
        seenPrompts.push(messages.map((m) => m.content ?? '').join('\n'));
        return { message: { role: 'assistant', content: '## In scope\n- the thing' }, finishReason: 'stop', usage: { promptTokens: 10, completionTokens: 5 } };
      },
      model: 'mock',
    };
    const { registry } = mkCtx(provider) as unknown as { registry: ToolRegistry };
    const t = registry.get('stage.run')!;
    const out = String(await t.execute({ command: '/planning', input: 'plan the login flow' }, { sessionId: 't', signal: undefined }));
    expect(out).toContain('## In scope');
    // SR1/child fidelity: the child's SYSTEM prompt is the command's instructions
    expect(seenPrompts[0]).toContain('SCOPE of testing');
    // depth cap: the child's toolset has NO stage.run
    expect(seenPrompts.length).toBe(1);
  });

  it('truncates stage output at 12k with a marker', async () => {
    const provider = {
      async complete() {
        return { message: { role: 'assistant', content: 'x'.repeat(20_000) }, finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1 } };
      },
      model: 'mock',
    };
    const { registry } = mkCtx(provider) as unknown as { registry: ToolRegistry };
    const t = registry.get('stage.run')!;
    const out = String(await t.execute({ command: '/breakdown', input: 'scope here' }, { sessionId: 't', signal: undefined }));
    expect(out.length).toBeLessThan(13_000);
    expect(out).toContain('truncated at');
  });
});
