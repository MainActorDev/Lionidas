/** In-place edit flow (plan 20261016T090000Z, slices A+B + repo resolution slice #1).
 *  The sess_451c34f0-ceb lesson: "edit in place" dead-ended with paste-ready git
 *  commands; now the host completes the flow — trigger guard, dirt partition,
 *  proposal-files-only commit with trailer, push/PR provenance, restore, clear LAST. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it, afterEach } from 'vitest';
import { resolveProposalRepo, completeInPlace, makeTurnDecorator } from '../src/agent/identifier-flow.ts';

const GIT = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
const GIT_OK = (cwd: string, ...args: string[]): boolean => { try { GIT(cwd, ...args); return true; } catch { return false; } };

let root: string;

function mkRepo(name: string, topDir: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  GIT(dir, 'init', '-q', '-b', 'main');
  GIT(dir, 'config', 'user.email', 't@t'); GIT(dir, 'config', 'user.name', 't');
  mkdirSync(join(dir, topDir), { recursive: true });
  writeFileSync(join(dir, topDir, 'View.swift'), 'struct View {}\n');
  GIT(dir, 'add', '.'); GIT(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

describe('slice #1 — repo resolution from proposal file paths', () => {
  it('Foodiary-prefixed paths claim the Foodiary clone', () => {
    root = mkdtempSync(join(tmpdir(), 'ip-'));
    const f = mkRepo('Foodiary', 'Foodiary'); void f;
    const intl = mkRepo('ios-consumer-intl', 'App'); void intl;
    const r = resolveProposalRepo(root, ['Foodiary/Views/Onboarding/WelcomeView.swift', 'Foodiary/Views/MainTabView.swift'], 'ios-consumer-intl');
    expect(r.repo).toBe('Foodiary');
    expect(r.how).toContain('Foodiary/');
  });
  it('App-prefixed paths claim the intl clone', () => {
    root = mkdtempSync(join(tmpdir(), 'ip-'));
    mkRepo('Foodiary', 'Foodiary'); mkRepo('ios-consumer-intl', 'App');
    const r = resolveProposalRepo(root, ['App/Sources/Coordinator.swift'], 'ios-consumer-intl');
    expect(r.repo).toBe('ios-consumer-intl');
  });
  it('zero claims fall back with an honest reason', () => {
    root = mkdtempSync(join(tmpdir(), 'ip-'));
    mkRepo('Foodiary', 'Foodiary');
    const r = resolveProposalRepo(root, ['Nowhere/File.swift'], 'Foodiary');
    expect(r.repo).toBe('Foodiary');
    expect(r.how).toMatch(/no path claims/);
  });
});

describe('in-place trigger guard (F1/F3/F5)', () => {
  it('F5: bare directive matches; questions do not', () => {
    const re = /^(edit|apply)\s+in\s+place$/i;
    expect(re.test('edit in place')).toBe(true);
    expect(re.test('Edit In Place')).toBe(true);
    expect(re.test('apply in place')).toBe(true);
    expect(re.test('can you apply in place?')).toBe(false);
    expect(re.test('please edit in place now')).toBe(false);
  });

  it('F1: dirty tracked file refuses the trigger', async () => {
    root = mkdtempSync(join(tmpdir(), 'ip-'));
    const repo = mkRepo('guardrepo', 'App');
    writeFileSync(join(repo, 'App', 'View.swift'), 'struct View { /* mid-edit */ }\n');
    const db = new Database(':memory:');
    const dec = makeTurnDecorator({ db, reposRoot: root, makeEditorProvider: (cwd) => ({ id: 'x' } as never), lastAssistant: () => 'proposal' });
    db.prepare("INSERT OR REPLACE INTO identifier_proposals(session_id, repo, slug, entries_json, created_at, state) VALUES ('s1','guardrepo','auto-x','[{\"identifier\":\"welcome_button\"}]',1,'pending')").run();
    const out = dec.prepareTurn('s1', { content: 'edit in place' });
    expect(out?.promptBlock ?? '').toMatch(/refused.*uncommitted changes/s);
    // state unchanged — still pending
    const st = (db.prepare('SELECT state FROM identifier_proposals WHERE session_id=?').get('s1') as { state: string }).state;
    expect(st).toBe('pending');
  });

  it('F3: an active worktree for the repo refuses (one lane at a time)', async () => {
    root = mkdtempSync(join(tmpdir(), 'ip-'));
    mkRepo('lanerepo', 'App');
    mkdirSync(join(root, '.wt', 'lanerepo-auto-x'), { recursive: true });
    const db = new Database(':memory:');
    const dec = makeTurnDecorator({ db, reposRoot: root, makeEditorProvider: (cwd) => ({ id: 'x' } as never), lastAssistant: () => 'p' });
    db.prepare("INSERT OR REPLACE INTO identifier_proposals(session_id, repo, slug, entries_json, created_at, state) VALUES ('s2','lanerepo','auto-x','[{\"identifier\":\"x_button\"}]',1,'pending')").run();
    const out = dec.prepareTurn('s2', { content: 'edit in place' });
    expect(out?.promptBlock ?? '').toMatch(/active worktree lanerepo-auto-x/);
  });
});

describe('completer (slice B): commit exactly the proposal files', () => {
  it('happy path: commit + PR + restore + cleared; pbxproj-style dirt excluded and restored', async () => {
    root = mkdtempSync(join(tmpdir(), 'ip-'));
    const repo = mkRepo('happyrepo', 'App');
    // local bare origin: the real flow pushes to GitHub; a bare repo stands in faithfully
    execFileSync('git', ['init', '-q', '--bare', join(root, 'happyrepo-origin.git')]);
    GIT(repo, 'remote', 'add', 'origin', join(root, 'happyrepo-origin.git'));
    GIT(repo, 'push', '-q', '-u', 'origin', 'main');
    // the "model's edits" (what the edit turn would leave):
    writeFileSync(join(repo, 'App', 'View.swift'), 'struct View { /* +id */ }\n');
    // tool dirt that must NOT ride along:
    writeFileSync(join(repo, 'project.pbxproj'), '/* regenerated */\n');
    mkdirSync(join(repo, '.derived-data'), { recursive: true });
    writeFileSync(join(repo, '.derived-data', 'x'), 'junk');

    const db = new Database(':memory:');
    makeTurnDecorator({ db, reposRoot: root, makeEditorProvider: (c) => ({ id: 'x' } as never), lastAssistant: () => 'p' }); // ensures table
    let pushed = '';
    const deps = {
      db,
      reposRoot: root,
      makeEditorProvider: (cwd: string) => ({ id: 'x', cwd } as never),
      lastAssistant: () => 'p',
      compileWorktree: async () => ({ scheme: 'App', app: '/tmp/x.app' }),
      // intercept pushAndPr via module seam is intrusive; instead assert via git state.
      onAuto: (m: string) => { if (m.includes('stashed')) pushed = m; },
    };
    // stub pushAndPr by pointing ghPath at a fake? completeInPlace calls pushAndPr directly.
    // For the unit test, patch process env PATH with a fake gh that prints a PR url:
    const bin = mkdtempSync(join(tmpdir(), 'bin-'));
    writeFileSync(join(bin, 'gh'), '#!/bin/sh\necho "https://github.com/o/r/pull/9"\n');
    execFileSync('chmod', ['+x', join(bin, 'gh')]);
    const realPath = process.env.PATH!;
    process.env.PATH = `${bin}:${realPath}`;
    try {
      db.prepare("INSERT OR REPLACE INTO identifier_proposals(session_id, repo, slug, entries_json, created_at, state) VALUES ('s3','happyrepo','auto-x','[{\"identifier\":\"welcome_button\"}]',1,'in-place')").run();
      const res = await completeInPlace(deps as never, { session_id: 's3', repo: 'happyrepo', slug: 'auto-x', entries: [{ identifier: 'welcome_button' }], created_at: 1, state: 'in-place' }, repo, 'turn1', 'edited `App/View.swift` at line 5');
      expect(res.note).toContain('1 file(s) committed');
      expect(res.note).toContain('pull/9');
      // commit contains EXACTLY the proposal file
      const files = GIT(repo, 'show', '--name-only', '--format=', 'feat/identifiers-auto-x').trim().split('\n');
      expect(files).toEqual(['App/View.swift']);
      // trailer present
      expect(GIT(repo, 'log', '-1', '--format=%B', 'feat/identifiers-auto-x')).toMatch(/Lionidas-In-Place: session s3, turn turn1, user-authorized/);
      // clone back on main, branch exists
      expect(GIT(repo, 'branch', '--show-current').trim()).toBe('main');
      expect(GIT_OK(repo, 'rev-parse', '--verify', 'refs/heads/feat/identifiers-auto-x')).toBe(true);
      expect(GIT_OK(repo, 'rev-parse', '--verify', 'refs/remotes/origin/feat/identifiers-auto-x')).toBe(true);
      // pbxproj dirt restored (stash popped)
      expect(readFileSync(join(repo, 'project.pbxproj'), 'utf8')).toContain('regenerated');
      // proposal row cleared
      expect((db.prepare('SELECT count(*) c FROM identifier_proposals').get() as { c: number }).c).toBe(0);
    } finally {
      process.env.PATH = realPath;
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it('compile failure parks honestly: no commit, edits kept, state in-place-failed', async () => {
    root = mkdtempSync(join(tmpdir(), 'ip-'));
    const repo = mkRepo('failrepo', 'App');
    writeFileSync(join(repo, 'App', 'View.swift'), 'struct View { /* +id */ }\n');
    const db = new Database(':memory:');
    makeTurnDecorator({ db, reposRoot: root, makeEditorProvider: (c) => ({ id: 'x' } as never), lastAssistant: () => 'p' }); // ensures table
    const deps = {
      db, reposRoot: root,
      makeEditorProvider: (cwd: string) => ({ id: 'x' } as never),
      lastAssistant: () => 'p',
      compileWorktree: async () => { throw new Error('xcodebuild: error: fabricated'); },
    };
    db.prepare("INSERT OR REPLACE INTO identifier_proposals(session_id, repo, slug, entries_json, created_at, state) VALUES ('s4','failrepo','auto-y','[{\"identifier\":\"b\"}]',1,'in-place')").run();
    await expect(completeInPlace(deps as never, { session_id: 's4', repo: 'failrepo', slug: 'auto-y', entries: [{ identifier: 'b' }], created_at: 1, state: 'in-place' }, repo, 'turn2', 'edited `App/View.swift`'))
      .rejects.toThrow(/xcodebuild: error/);
    // nothing committed: the only commit is still the fixture's init
    expect(GIT(repo, 'log', '--format=%s').trim()).toBe('init');
    const st = (db.prepare('SELECT state FROM identifier_proposals WHERE session_id=?').get('s4') as { state: string }).state;
    expect(st).toBe('in-place-failed');
    // edits still on disk
    expect(readFileSync(join(repo, 'App', 'View.swift'), 'utf8')).toContain('+id');
  });
});
