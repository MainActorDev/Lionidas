/** /implement-identifiers auto-flow state machine (identifier-flow.ts).
 *  The sess_e157cc04 gap: the command promised "the host creates the worktree"
 *  but nothing did. These tests pin the machine: proposal parking, bare-word
 *  confirmation → worktree + editor provider swap, decline → cleanup, and the
 *  afterTurn commit/push/cleanup path (git mocked at the driver seam). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import type { Provider } from '@mainactordev/butler';
import { makeTurnDecorator, answerIsProposal, setPending, getProposal } from '../src/agent/identifier-flow.ts';

let root: string;
let reposRoot: string;
let db: Database.Database;

const EDITOR: Provider = { model: 'editor-stub', complete: async () => ({ message: { role: 'assistant' as const, content: 'done' }, finishReason: 'end_turn', usage: { promptTokens: 1, completionTokens: 1 } }) };
let editorCwds: string[] = [];

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
}

/** a real repo with one committed Swift file, plus its origin (for pushAndPr) */
function makeRepo(name: string, file: string, content: string): string {
  const dir = join(reposRoot, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-b', 'develop');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  mkdirSync(join(dir, 'Modules'), { recursive: true });
  writeFileSync(join(dir, file), content);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
  // local origin: a bare clone the worktree can push to
  const origin = join(reposRoot, `${name}-origin.git`);
  execFileSync('git', ['clone', '--bare', dir, origin], { encoding: 'utf8' });
  git(dir, 'remote', 'add', 'origin', origin);
  git(dir, 'fetch', 'origin');
  git(dir, 'branch', '--set-upstream-to=origin/develop', 'develop');
  return dir;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'idflow-'));
  reposRoot = join(root, 'repos');
  mkdirSync(reposRoot, { recursive: true });
  db = new Database(join(root, 'agent.db'));
  makeRepo('app', 'Modules/A.swift', 'let x = 1\n');
});

afterAll(() => { rmSync(root, { recursive: true, force: true }); });

function decorator() {
  editorCwds = [];
  return makeTurnDecorator({
    db, reposRoot,
    makeEditorProvider: (cwd) => { editorCwds.push(cwd); return EDITOR; },
    lastAssistant: () => '',
    onAuto: () => {},
  });
}

describe('answerIsProposal (the parking detector)', () => {
  it('recognizes the hard-stop proposal shape', () => {
    expect(answerIsProposal('# /implement-identifiers — proposal (HARD STOP before any edit)')).toBe(true);
    expect(answerIsProposal('## /implement-identifiers — edit set finalized\nConfirm implementing these 5 identifiers? (all / pick numbers)')).toBe(true);
  });
  it('non-proposal answers do not park', () => {
    expect(answerIsProposal('All five cases are parked. See you next merge.')).toBe(false);
    expect(answerIsProposal('the identifiers exist already')).toBe(false);
  });
});

describe('the state machine', () => {
  it('bare confirmation swaps provider to the editor child with cwd=worktree', () => {
    setPending(db, { session_id: 's1', repo: 'app', slug: 'w1', entries: [{ identifier: 'a_button' }], created_at: Date.now() });
    const d = decorator();
    const out = d.prepareTurn('s1', { content: 'All' });
    expect(out?.provider).toBe(EDITOR);
    expect(editorCwds).toHaveLength(1);
    expect(out?.promptBlock).toMatch(/WORKTREE EDIT TURN/);
    // the worktree exists on disk
    const wtPath = editorCwds[0]!;
    expect(readFileSync(join(wtPath, 'Modules/A.swift'), 'utf8')).toContain('let x = 1');
    expect(getProposal(db, 's1')?.state).toBe('confirmed');
  });

  it('decline clears the proposal; no provider swap', () => {
    setPending(db, { session_id: 's2', repo: 'app', slug: 'w2', entries: [{ identifier: 'a_button' }], created_at: Date.now() });
    const d = decorator();
    const out = d.prepareTurn('s2', { content: 'cancel' });
    expect(out?.provider).toBeUndefined();
    expect(editorCwds).toHaveLength(0);
    expect(out?.promptBlock).toMatch(/declined/);
    expect(getProposal(db, 's2')).toBeNull();
  });

  it('a question does NOT consume the confirmation (proposal stays pending)', () => {
    setPending(db, { session_id: 's3', repo: 'app', slug: 'w3', entries: [{ identifier: 'a_button' }], created_at: Date.now() });
    const d = decorator();
    const out = d.prepareTurn('s3', { content: 'wait, which files will you touch?' });
    expect(out).toBeNull();
    expect(getProposal(db, 's3')?.state).toBe('pending');
  });

  it('pick-numbers confirmation counts ("1, 3")', () => {
    const d = decorator();
    const out = d.prepareTurn('s3', { content: '1, 3' });
    expect(out?.provider).toBe(EDITOR);
  });

  it('afterTurn on the edit turn: commits per identifier, pushes, cleans up', () => {
    // s3 is confirmed now; write an edit into its worktree manually
    const p = getProposal(db, 's3')!;
    const wtPath = join(reposRoot, '.wt', `app-${p.slug}`);
    writeFileSync(join(wtPath, 'Modules/A.swift'), 'let x = 2\n');
    const d = decorator();
    d.afterTurn('s3', { ok: true, turnId: 't1', answer: 'edited 1 file' });
    // proposal cleared, worktree gone
    expect(getProposal(db, 's3')).toBeNull();
    let exists = true;
    try { readFileSync(wtPath); } catch { exists = false; }
    expect(exists).toBe(false);
    // the commit landed on the origin bare repo's pushed branch
    const originDir = join(reposRoot, 'app-origin.git');
    const refs = git(originDir, 'for-each-ref', '--format=%(refname)', 'refs/heads/feat/identifiers-*');
    expect(refs).toMatch(/feat\/identifiers-w3/);
  });

  it('a failed worktree creation reports and clears (never strands the session)', () => {
    setPending(db, { session_id: 's4', repo: 'no-such-repo', slug: 'w4', entries: [{ identifier: 'a_button' }], created_at: Date.now() });
    const d = decorator();
    const out = d.prepareTurn('s4', { content: 'yes' });
    expect(out?.provider).toBeUndefined();
    expect(out?.promptBlock).toMatch(/failed/);
    expect(getProposal(db, 's4')).toBeNull();
  });
});
