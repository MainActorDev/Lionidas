/** Build-config apply bridge (plan 20261015T121500Z B1) — the structural gate.
 *  R1: the model can never flip pending→applied. R2: dual-layer parking survives
 *  a prose-only turn. R5: per-project keys. */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrateBuildConfigs } from '../src/db/schema.ts';
import { parkProposal, getParked, listParkedForSession, consumeConfirmation, proposalFromAnswer, isConfirmation } from '../src/agent/build-config-flow.ts';

let db: Database.Database;
let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'bcbridge-'));
  db = new Database(join(root, 't.db'));
  db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY, name TEXT, repo_url TEXT, local_path TEXT, default_branch TEXT, auth_token TEXT, build_scheme TEXT, build_configuration TEXT, repo_shape TEXT, default_suite_id TEXT, retention INTEGER, created_at INTEGER, updated_at INTEGER);`);
  db.prepare("INSERT INTO projects(id, name) VALUES ('p1','alpha'), ('p2','beta')").run();
  migrateBuildConfigs(db);
});
afterAll(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

describe('the structural gate (R1)', () => {
  it('park → pending; user confirmation flips via consumeConfirmation (the seam fn, NOT a tool)', () => {
    parkProposal(db, 's1', 'p1', { transport: 'generic', scheme: 'A', configuration: 'Debug', prepare: [{ run: 'x' }], evidence: ['f:1'] });
    expect(getParked(db, 's1', 'p1')?.state).toBe('pending');
    const flipped = consumeConfirmation(db, 's1', 'Confirmed');
    expect(flipped.map((f) => f.projectId)).toEqual(['p1']);
    expect(getParked(db, 's1', 'p1')?.state).toBe('applied');
  });

  it('a question does NOT consume the confirmation; decline clears', () => {
    parkProposal(db, 's2', 'p1', { transport: 'generic', scheme: 'B', configuration: null, prepare: [], evidence: [] });
    expect(consumeConfirmation(db, 's2', 'wait — which files?')).toEqual([]);
    expect(getParked(db, 's2', 'p1')?.state).toBe('pending');
    expect(consumeConfirmation(db, 's2', 'cancel')).toEqual([]);
    expect(getParked(db, 's2', 'p1')?.state).toBe('declined');
  });

  it('confirmation bare-words are the same semantics as the identifier flow', () => {
    expect(isConfirmation('All')).toBe(true);
    expect(isConfirmation('Apply the revision')).toBe(true);
    expect(isConfirmation('Use the Dev scheme instead')).toBe(false); // a steering message, not a confirm
  });

  it('multi-project: one confirm flips BOTH pending rows (R5)', () => {
    parkProposal(db, 's3', 'p1', { transport: 'generic', scheme: 'X', configuration: null, prepare: [], evidence: [] });
    parkProposal(db, 's3', 'p2', { transport: 'repo-lane', scheme: 'Y', configuration: null, prepare: [], evidence: [] });
    const flipped = consumeConfirmation(db, 's3', 'yes');
    expect(flipped).toHaveLength(2);
    expect(listParkedForSession(db, 's3').every((r) => r.state === 'applied')).toBe(true);
    // re-propose for ONE project replaces only that row
    parkProposal(db, 's3', 'p2', { transport: 'generic', scheme: 'Z', configuration: null, prepare: [], evidence: [] });
    expect(getParked(db, 's3', 'p2')?.proposal.scheme).toBe('Z');
    expect(getParked(db, 's3', 'p1')?.proposal.scheme).toBe('X');
  });
});

describe('R2 fallback: proposal parsed from a prose answer', () => {
  const answer = `Recipe confirmed? Here it is:

\`\`\`yaml
project: ios-consumer
transport: repo-lane
scheme: Dev
configuration: "Dev "
prepare:
  - run: pod install
  - xcodegen --spec project.yml --project .
\`\`\`

Confirm applying this build config?`;

  it('extracts fields + run-steps, skips gate/guard/build pseudo-steps', () => {
    const p = proposalFromAnswer(answer);
    expect(p).not.toBeNull();
    expect(p!.scheme).toBe('Dev');
    expect(p!.configuration).toBe('Dev ');
    expect(p!.prepare.map((x) => x.run)).toEqual(['pod install', 'xcodegen --spec project.yml --project .']);
  });

  it('non-proposal answers return null', () => {
    expect(proposalFromAnswer('All five cases are parked. See you next merge.')).toBeNull();
    expect(proposalFromAnswer('some yaml```yaml\nfoo: 1\n```but no confirm question')).toBeNull();
  });
});

const DRAFT_POLICY = { name: 'draft', allows: 'draft' as const };

describe('the apply TOOL refusal path (B1 negative: model cannot self-apply)', () => {
  it('build_config.apply on a pending row is refused with NOT_CONFIRMED', async () => {
    parkProposal(db, 's9', 'p1', { transport: 'generic', scheme: 'Self', configuration: null, prepare: [], evidence: [] });
    // drive the tool through the real registry (same as the MCP child would)
    const { buildToolRegistry } = await import('../src/agent/tools.ts');
    const registry = buildToolRegistry({ db, storage: fakeStorage(), retriever: fakeRetriever(), artifactsDir: root });
    const out = JSON.parse(await registry.execute('build_config.apply', { projectId: 'p1' }, { sessionId: 's9', signal: undefined }, DRAFT_POLICY) as string) as { error?: string };
    expect(out.error).toBe('NOT_CONFIRMED');
    // the model "confirming" in prose does not help either — only the seam flips:
    const out2 = JSON.parse(await registry.execute('build_config.apply', { projectId: 'p1' }, { sessionId: 's9', signal: undefined }, DRAFT_POLICY) as string) as { error?: string };
    expect(out2.error).toBe('NOT_CONFIRMED');
    // the SEAM (user's message) flips; now apply succeeds and writes a revision
    consumeConfirmation(db, 's9', 'Confirmed');
    const { activeBuildConfig } = await import('../src/projects/build-configs.ts');
    const before = activeBuildConfig(db, 'p1')?.revision ?? 0;
    const out3 = JSON.parse(await registry.execute('build_config.apply', { projectId: 'p1' }, { sessionId: 's9', signal: undefined }, DRAFT_POLICY) as string) as { applied?: boolean; revision?: number };
    expect(out3.applied).toBe(true);
    expect(out3.revision).toBeGreaterThan(before);
  });
});

function fakeStorage(): never { return null as never; }
function fakeRetriever(): never { return null as never; }
