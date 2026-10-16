/** /implement-identifiers auto-orchestration (plan 20261014T132710Z Phase IIIb —
 *  the sess_e157cc04 finding: "the host creates the worktree" had no host).
 *
 *  State machine, persisted in the agent DB (crash-safe, survives restarts):
 *    pending(repo, slug, entries)  ← set when a proposal turn ENDS with the hard-stop
 *                                    question (detected by afterTurn on the command turn)
 *    confirmed → worktree          ← the NEXT user turn on that session runs INSIDE the
 *                                    worktree (prepareTurn swaps the provider)
 *    done                        ← afterTurn commits/pushes/PRs and cleans up
 *    discarded                    ← user declined ("no"/"cancel" content) — worktree removed
 *
 *  The human confirmation stays human: the machine only acts AFTER the user's
 *  next message on the session. */
import Database from 'better-sqlite3';
import { dirname, join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createWorktree, commitEach, pushAndPr, removeWorktree } from './worktree.ts';
import type { Provider } from '@mainactordev/butler';

export interface PendingProposal {
  session_id: string;
  repo: string;
  slug: string;
  /** identifiers to implement (drives per-identifier commits) */
  entries: Array<{ identifier: string; screen?: string; caseId?: string }>;
  created_at: number;
}

const CONFIRM_RE = /^\s*(all|yes|y|go|ok|confirm|do it|go for it|proceed|apply)\b/i;
const DECLINE_RE = /^\s*(no|n\b|cancel|stop|discard|skip|never\s*mind|abort)\b/i;

function ensureTable(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS identifier_proposals (
    session_id TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    slug TEXT NOT NULL,
    entries_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    pre_existing_dirt_json TEXT
  )`);
  // pre-existing-dirt snapshot column (in-place flow, plan 20261016T090000Z F1):
  // lightweight ADD COLUMN migration for DBs created before the column existed.
  const cols = db.prepare("SELECT name FROM pragma_table_info('identifier_proposals')").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'pre_existing_dirt_json')) {
    db.exec('ALTER TABLE identifier_proposals ADD COLUMN pre_existing_dirt_json TEXT');
  }
}

/** Resolve which registered repo a proposal targets from its FILE PATHS (slice #1,
 *  the sess_451c34f0-ceb wrong-repo lesson: parking hardcoded 'ios-consumer-intl').
 *  Host resolves, never the model. Matching: a repo claims the proposal when one of
 *  its first-path-segment directories exists in the clone (Foodiary/Views/… ⇒ the
 *  Foodiary clone has Foodiary/; App/… ⇒ ios-consumer-intl has App/). Exactly one
 *  claim wins; ambiguity or zero claims falls back to the first registered repo and
 *  logs loudly — discovery is never silent. */
export function resolveProposalRepo(reposRoot: string, filePaths: string[], fallback: string): { repo: string; how: string } {
  const candidates: Array<{ repo: string; firstSeg: string }> = [];
  try {
    for (const repo of readdirSync(reposRoot, { withFileTypes: true })) {
      if (!repo.isDirectory() || repo.name.startsWith('.') || repo.name === 'crucible.db') continue;
      const firstSegs = new Set<string>();
      for (const f of filePaths) {
        const seg = f.trim().replace(/^\.\//, '').split('/')[0];
        if (seg && !seg.endsWith('.swift') && !seg.endsWith('.yml') && !seg.endsWith('.md')) firstSegs.add(seg);
      }
      for (const seg of firstSegs) {
        if (existsSync(join(reposRoot, repo.name, seg))) candidates.push({ repo: repo.name, firstSeg: seg });
      }
    }
  } catch { /* unreadable repos root → fallback */ }
  const uniqRepos = [...new Set(candidates.map((c) => c.repo))];
  if (uniqRepos.length === 1) return { repo: uniqRepos[0]!, how: `file paths claim ${candidates[0]!.firstSeg}/` };
  if (uniqRepos.length > 1) {
    // disambiguate on the SECOND segment: 'Foodiary/Views/…' ⇒ the repo that has
    // Foodiary/Views/ beats one that merely has Foodiary/
    const deep = candidates.find((c) => {
      const two = filePaths.find((f) => typeof f === 'string' && f.replace(/^\.\//, '').split('/')[0] === c.firstSeg && f.split('/').length > 2);
      return two ? existsSync(join(reposRoot, c.repo, two.replace(/^\.\//, '').split('/').slice(0, 2).join('/'))) : false;
    });
    if (deep) return { repo: deep.repo, how: `deep claim ${deep.firstSeg}/…` };
    return { repo: fallback, how: `AMBIGUOUS (${uniqRepos.join(', ')}) — fell back` };
  }
  return { repo: fallback, how: 'no path claims — fell back' };
}

export function setPending(db: Database.Database, p: PendingProposal): void {
  ensureTable(db);
  db.prepare('INSERT OR REPLACE INTO identifier_proposals(session_id, repo, slug, entries_json, created_at, state) VALUES (?,?,?,?,?,?)')
    .run(p.session_id, p.repo, p.slug, JSON.stringify(p.entries), p.created_at, 'pending');
}

export function getProposal(db: Database.Database, sessionId: string): (PendingProposal & { state: string }) | null {
  ensureTable(db);
  const row = db.prepare('SELECT * FROM identifier_proposals WHERE session_id = ?').get(sessionId) as
    { session_id: string; repo: string; slug: string; entries_json: string; created_at: number; state: string } | undefined;
  if (!row) return null;
  return { session_id: row.session_id, repo: row.repo, slug: row.slug, entries: JSON.parse(row.entries_json), created_at: row.created_at, state: row.state };
}

function clearProposal(db: Database.Database, sessionId: string): void {
  ensureTable(db);
  db.prepare('DELETE FROM identifier_proposals WHERE session_id = ?').run(sessionId);
}

/** does an assistant answer look like the /implement-identifiers hard-stop proposal?
 *  The command spec MANDATES the closing question ("end your turn with the table
 *  and the question 'Confirm implementing these N identifiers? (all / pick
 *  numbers)'") — that question IS the contract, command-name mentions are not
 *  (live drill: the agent titled its proposal without the literal command). */
export function answerIsProposal(answer: string): boolean {
  return /confirm implementing\s+(these\s+)?\d+\s+identifiers?/i.test(answer) || /HARD STOP.*implement|implement.*HARD STOP/is.test(answer);
}

export interface DecoratorDeps {
  db: Database.Database;          // agent db (proposals live beside the event log)
  reposRoot: string;
  makeEditorProvider: (cwd: string) => Provider;
  /** the last assistant message on the session before this turn (for proposal detection) */
  lastAssistant: (sessionId: string) => string;
  onAuto?: (msg: string) => void; // observability (server log)
  /** compile gate override (tests). Production path: ../projects/builds.ts compileWorktree */
  compileWorktree?: (ws: string, log: (l: string) => void) => Promise<{ scheme: string; app: string }>;
}

/** last meaningful line of a compile failure for the log/notification */
function logTail(_wtPath: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const last = msg.trim().split('\n').pop() ?? msg;
  return last.slice(0, 300);
}

export function makeTurnDecorator(deps: DecoratorDeps) {
  ensureTable(deps.db);
  return {
    /** the turn AFTER the proposal: user content is the confirmation/decline */
    prepareTurn: (sessionId: string, body: { content: string; commands?: string[] }): { promptBlock?: string; provider?: Provider } | null => {
      const p = getProposal(deps.db, sessionId);
      if (!p || p.state !== 'pending') return null;
      const content = body.content.trim();
      // Only a bare confirmation/decline drives the machine — a question or new
      // command keeps the proposal pending (the user may still confirm later).
      const isConfirm = CONFIRM_RE.test(content) || /^\s*(\d+([,\s]+\d+)*)\s*$/.test(content);
      const isDecline = DECLINE_RE.test(content);
      // in-place directive (plan 20261016T090000Z F5): BARE single-sentence only —
      // questions/prose containing the phrase keep the proposal pending.
      const isInPlace = /^(edit|apply)\s+in\s+place$/i.test(content.trim()) && !/\n|\.|\?/.test(content.trim());
      if (!isConfirm && !isDecline && !isInPlace) return null;
      if (isInPlace) {
        // ── IN-PLACE EDIT TURN (plan 20261016T090000Z) ──
        const clonePath = join(deps.reposRoot, p.repo);
        if (!existsSync(join(clonePath, '.git'))) {
          return { promptBlock: `\n\n--- IN-PLACE FLOW: no canonical clone at ${clonePath} — cannot edit in place. Report and ask how to proceed. ---` };
        }
        try {
          const guard = guardInPlacePreconditions(clonePath, p);
          if (!guard.ok) {
            deps.onAuto?.(`[implement-identifiers] in-place REFUSED on ${sessionId}: ${guard.reason}`);
            return { promptBlock: `\n\n--- IN-PLACE FLOW: refused — ${guard.reason} Ask the user to resolve and retry 'edit in place'. ---` };
          }
          deps.db.prepare("UPDATE identifier_proposals SET state = 'in-place', pre_existing_dirt_json = ? WHERE session_id = ?").run(JSON.stringify(guard.preExistingDirt), sessionId);
          deps.onAuto?.(`[implement-identifiers] in-place on ${sessionId}: repo=${p.repo}, ${guard.preExistingDirt.length} pre-existing dirt paths snapshotted — edit turn starting`);
          return {
            provider: deps.makeEditorProvider(clonePath),
            promptBlock: `\n\n--- IN-PLACE EDIT TURN — you are editing the CANONICAL clone ${clonePath} (repo ${p.repo}), user-authorized in place ---\nApply the EXACT edit set from your proposal (same files, same lines, same identifiers) using your native file tools (Read/Edit/Write). Follow the repo's own convention (constants catalog if one exists, inline literals otherwise). Do NOT run git, do NOT commit or push — the host commits exactly the proposal's files and opens the PR after your turn. When done, list every file+line you changed. ---`,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          deps.onAuto?.(`[implement-identifiers] in-place trigger FAILED on ${sessionId}: ${msg}`);
          return { promptBlock: `\n\n--- IN-PLACE FLOW: trigger failed (${msg}). Report the failure; do not attempt edits. ---` };
        }
      }
      if (isDecline) {
        clearProposal(deps.db, sessionId);
        deps.onAuto?.(`[implement-identifiers] proposal declined on ${sessionId} — cleared`);
        return { promptBlock: '\n\n--- WORKTREE FLOW: declined — no edits were made. Acknowledge the cancellation briefly. ---' };
      }
      // CONFIRMED: create the worktree NOW (host owns git), swap the turn's
      // provider to the editor child (cwd = worktree, Edit/Write allowed).
      const slug = p.slug;
      try {
        const wt = createWorktree(deps.reposRoot, p.repo, slug);
        deps.db.prepare("UPDATE identifier_proposals SET state = 'confirmed' WHERE session_id = ?").run(sessionId);
        deps.onAuto?.(`[implement-identifiers] confirmed on ${sessionId} — worktree ${wt.branch} created`);
        return {
          provider: deps.makeEditorProvider(wt.path),
          promptBlock: `\n\n--- WORKTREE EDIT TURN — you are editing inside the git worktree ${wt.path} (branch ${wt.branch}) ---
Apply the EXACT edit set from your proposal (same files, same lines, same identifiers) using your native file tools (Read/Edit/Write). The constant definitions go in Modules/LPDesignSystem/Sources/LPDesignSystem/SwiftUI/AccessibilityIdentifiers.swift per the app's convention; the call-site modifiers per your proposal table. Do NOT run git or push — the host commits and opens the PR after your turn. When done, list every file+line you changed. ---`,
        };
      } catch (err) {
        clearProposal(deps.db, sessionId);
        const msg = err instanceof Error ? err.message : String(err);
        deps.onAuto?.(`[implement-identifiers] worktree creation FAILED on ${sessionId}: ${msg}`);
        return { promptBlock: `\n\n--- WORKTREE FLOW: worktree creation failed (${msg}). Report the failure; do not attempt edits. ---` };
      }
    },

    /** the turn that ENDS as a proposal parks it; the edit turn commits/pushes/PRs */
    afterTurn: async (sessionId: string, outcome: { ok: boolean; turnId: string; answer: string }): Promise<void> => {
      const p = getProposal(deps.db, sessionId);
      if (p && p.state === 'in-place') {
        // ── IN-PLACE COMPLETER (plan 20261016T090000Z slices A+B) ──
        // host-side git; model keeps editor tools only. Ordering per review F2:
        // stash → compile → commit → push/PR → restore → clear LAST.
        const clonePath = join(deps.reposRoot, p.repo);
        if (!outcome.ok) {
          deps.db.prepare("UPDATE identifier_proposals SET state = 'in-place-failed' WHERE session_id = ?").run(sessionId);
          deps.onAuto?.(`[implement-identifiers] ${sessionId}: IN-PLACE EDIT TURN FAILED (${outcome.turnId}) — edits kept at ${clonePath}; nothing committed`);
          return;
        }
        try {
          const result = await completeInPlace(deps, p, clonePath, outcome.turnId, outcome.answer);
          deps.onAuto?.(`[implement-identifiers] ${sessionId}: in-place COMPLETE — ${result.note}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          deps.onAuto?.(`[implement-identifiers] ${sessionId}: IN-PLACE COMPLETE FAILED — ${msg}. Edits still at ${clonePath}; state parked`);
        }
        return;
      }
      if (p && p.state === 'confirmed') {
        // claim the state synchronously — afterTurn is fire-and-forget at the
        // transport seam, and the compile gate runs for minutes; a second turn
        // must never re-enter the confirm path while it runs
        deps.db.prepare("UPDATE identifier_proposals SET state = 'compiling' WHERE session_id = ?").run(sessionId);
        if (!outcome.ok) {
          // the EDIT turn itself failed (provider error, context exhaustion) —
          // committing half-edits and pushing them is worse than parking: keep
          // the worktree on disk for a retry, mark the state, log loudly.
          deps.db.prepare("UPDATE identifier_proposals SET state = 'edit-failed' WHERE session_id = ?").run(sessionId);
          deps.onAuto?.(`[implement-identifiers] ${sessionId}: EDIT TURN FAILED (${outcome.turnId}) — worktree kept at .wt/${p.repo}-${p.slug} for inspection/retry; nothing committed`);
          return;
        }
        // the edit turn just settled → commit, push, PR, cleanup (host owns git)
        try {
          const wt = { repo: p.repo, slug: p.slug, path: join(deps.reposRoot, '.wt', `${p.repo}-${p.slug}`), branch: `feat/identifiers-${p.slug}` };
          // COMPILE GATE (user decision, lionidas CI semantics): before anything is
          // committed or pushed, the edited worktree must build through the SAME
          // proven path as /builds — transport, manifest prepare steps (config
          // wiring, xcodegen, scipio, SPM resolve), preflight, xcodebuild — but
          // compile-only: no .ipa packaging, no smoke, no package claim. A red
          // compile parks the worktree instead of pushing broken code.
          try {
            const compile = deps.compileWorktree ?? (await import('../projects/builds.ts')).compileWorktree;
            const t0 = Date.now();
            const logLines: string[] = [];
            const res = await compile(wt.path, (l) => { logLines.push(l); });
            deps.onAuto?.(`[implement-identifiers] ${sessionId}: compile OK (${res.scheme}, ${Math.round((Date.now() - t0) / 1000)}s) — ${res.app.split('/').pop()}`);
          } catch (cerr) {
            const tail = logTail(wt.path, cerr);
            deps.db.prepare("UPDATE identifier_proposals SET state = 'compile-failed' WHERE session_id = ?").run(sessionId);
            deps.onAuto?.(`[implement-identifiers] ${sessionId}: COMPILE FAILED — nothing committed/pushed; worktree kept at .wt/${p.repo}-${p.slug}. ${tail}`);
            return;
          }
          const messages = commitEach(wt, p.entries);
          // push lands even without gh/network: branch on origin is reviewable;
          // PR creation degrades to a log line when gh is absent (offline dev boxes)
          let prNote = 'no gh — branch pushed, open the PR manually';
          try {
            const pr = pushAndPr(wt, {
              title: `feat(a11y): add ${p.entries.length} accessibility identifiers`,
              body: `Identifiers implemented via /implement-identifiers (session ${sessionId}, turn ${outcome.turnId}):\n\n${p.entries.map((e) => `- \`${e.identifier}\`${e.screen ? ` (${e.screen})` : ''}${e.caseId ? ` — unblocks ${e.caseId}` : ''}`).join('\n')}\n\nCI compile check gates the merge.`,
            });
            prNote = pr.url;
          } catch (prErr) {
            deps.onAuto?.(`[implement-identifiers] ${sessionId}: PR creation skipped (${prErr instanceof Error ? prErr.message : String(prErr)})`);
          }
          removeWorktree(deps.reposRoot, wt);
          clearProposal(deps.db, sessionId);
          deps.onAuto?.(`[implement-identifiers] ${sessionId}: ${messages.length} commits pushed — ${prNote}`);
        } catch (err) {
          // commits/PR failed — keep the worktree on disk (recoverable), park state for retry
          const msg = err instanceof Error ? err.message : String(err);
          deps.db.prepare("UPDATE identifier_proposals SET state = 'commit-failed' WHERE session_id = ?").run(sessionId);
          deps.onAuto?.(`[implement-identifiers] ${sessionId}: commit/push FAILED (${msg}) — worktree kept for recovery`);
        }
        return;
      }
      if (outcome.ok && answerIsProposal(outcome.answer)) {
        // a fresh proposal ended the turn — park it. entries come from the answer's
        // identifier list (the proposal table names them; the edit turn re-reads code)
        const ids = [...outcome.answer.matchAll(/`([a-z][a-z0-9_]*_[a-z0-9_]+)`/g)].map((m) => m[1]!).filter((x) => /_(button|field|row|cell|view|bar|item|link)$/.test(x) || /^(account|edit_profile|home|auth)_/.test(x));
        if (!ids.length) return;
        const uniq = [...new Set(ids)];
        const slug = `auto-${sessionId.slice(-6)}`;
        // repo from the proposal's FILE PATHS (backticked .swift paths in the answer),
        // not a hardcode — the wrong-repo lesson. Fallback: first registered repo.
        const filePaths = [...outcome.answer.matchAll(/[`]([^`\n]+\.swift)[`]/g)].map((m) => m[1]!);
        const { repo, how } = resolveProposalRepo(deps.reposRoot, filePaths, readdirSync(deps.reposRoot, { withFileTypes: true }).find((e) => e.isDirectory() && !e.name.startsWith('.'))?.name ?? 'ios-consumer-intl');
        setPending(deps.db, { session_id: sessionId, repo, slug, entries: uniq.map((identifier) => ({ identifier, screen: identifier.split('_')[0]!, })), created_at: Date.now() });
        deps.onAuto?.(`[implement-identifiers] proposal parked on ${sessionId}: ${uniq.length} identifiers, repo=${repo} (${how}) — awaiting user confirmation`);
      }
    },
  };
}

// ── in-place helpers (plan 20261016T090000Z; review F1/F2/F3) ──

/** porcelain parser → {path, staged, untracked} rows */
function porcelain(clonePath: string): Array<{ path: string; staged: boolean; untracked: boolean }> {
  const out = execFileSync('git', ['-C', clonePath, 'status', '--porcelain'], { encoding: 'utf8' });
  return out.split('\n').filter(Boolean).map((l) => ({
    staged: /^[MARD]/.test(l),
    untracked: l.startsWith('??'),
    path: l.slice(3).trim().replace(/^"|"$/g, ''),
  }));
}

/** F1 guard: proposal files must be clean; snapshot non-proposal dirt for afterTurn. */
function guardInPlacePreconditions(clonePath: string, p: PendingProposal & { state: string }): { ok: true; preExistingDirt: string[] } | { ok: false; reason: string } {
  // F3 exclusivity: an active worktree for this repo means another lane is running —
  // in-place compile and worktree creation share .git locks; one lane at a time.
  const wtDir = join(dirname(clonePath), '.wt');
  for (const wt of existsSync(wtDir) ? readdirSync(wtDir) : []) {
    if (wt.startsWith(`${p.repo}-`)) return { ok: false, reason: `active worktree ${wt} exists for this repo — one lane at a time (remove it or use the worktree flow)` };
  }
  // F1: the trigger fires BEFORE the model edits — ANY dirty tracked file (staged or
  // modified) is pre-existing. Proposal file paths aren't known until the edit turn
  // lists them, so the contract is conservative: no tracked file may be pre-dirty.
  // A human's mid-edit must never ride under the agent's trailer. Untracked dirt
  // (.derived-data/, regen artifacts) is tolerable — snapshotted, stashed at completion.
  const rows = porcelain(clonePath);
  const modified = rows.filter((r) => !r.untracked);
  if (modified.length) {
    const first = modified[0]!.path;
    return { ok: false, reason: `tracked file already has uncommitted changes (${first}${modified.length > 1 ? ` +${modified.length - 1} more` : ''}) — commit or discard first` };
  }
  return { ok: true, preExistingDirt: rows.filter((r) => r.untracked).map((r) => r.path) };
}

/** F2 branch name with collision suffix */
function freshBranchName(clonePath: string, base: string): string {
  let name = base; let n = 2;
  const exists = (b: string): boolean => {
    try { execFileSync('git', ['-C', clonePath, 'rev-parse', '--verify', `refs/heads/${b}`], { encoding: 'utf8', stdio: 'ignore' }); return true; } catch { return false; }
  };
  while (exists(name)) name = `${base}-${n++}`;
  return name;
}

/** the host-side completer: stash → compile → commit (proposal files only) → push/PR → restore → clear LAST */
export async function completeInPlace(deps: DecoratorDeps, p: PendingProposal & { state: string; pre_existing_dirt_json?: string | null }, clonePath: string, turnId: string, answer0: string): Promise<{ note: string }> {
  ensureTable(deps.db);
  const git = (...args: string[]): string => execFileSync('git', ['-C', clonePath, ...args], { encoding: 'utf8' });
  // files the model reports having changed (from the turn's answer: backticked .swift paths)
  const files = [...new Set([...answer0.matchAll(/[`]([^`\n]+\.swift)[`]/g)].map((m) => m[1]!))];
  const proposalFiles = files.filter((f) => existsSync(join(clonePath, f)));
  if (!proposalFiles.length) throw new Error('no edited .swift files found in the turn answer — refusing to commit anything');
  // partition: stash everything dirty that is NOT a proposal file
  const dirt = porcelain(clonePath).filter((r) => !r.path.startsWith('.lionidas')).map((r) => r.path);
  const toStash = [...new Set(dirt.filter((d) => !proposalFiles.includes(d)))];
  let stashKept = false;
  if (toStash.length) {
    git('stash', 'push', '--include-untracked', '-m', `lionidas-in-place ${p.slug}`, '--', ...toStash);
    deps.onAuto?.(`[implement-identifiers] in-place: stashed ${toStash.length} non-proposal path(s) (${toStash.slice(0, 3).join(', ')}${toStash.length > 3 ? '…' : ''})`);
  }
  try {
    // COMPILE GATE — same proven path, compile-only; nothing red is ever pushed
    const compile = deps.compileWorktree ?? (await import('../projects/builds.ts')).compileWorktree;
    const compileRes = await compile(clonePath, () => undefined);
    void compileRes;
    // commit exactly the proposal files, with trailer
    const branch = freshBranchName(clonePath, `feat/identifiers-${p.slug}`);
    git('checkout', '-q', '-b', branch);
    git('add', '--', ...proposalFiles);
    git('commit', '-q', '-m', `feat(a11y): add ${p.entries.length} accessibility identifiers (in-place)\n\nLionidas-In-Place: session ${p.session_id}, turn ${turnId}, user-authorized\nRepo: ${p.repo}`);
    // push + PR with provenance prefix (F4: bodyPrefix via direct body construction)
    const pr = pushAndPr({ repo: p.repo, slug: p.slug, path: clonePath, branch }, {
      title: `feat(a11y): add ${p.entries.length} accessibility identifiers`,
      body: `**Applied in-place, user-authorized** (session ${p.session_id}, turn ${turnId}).\n\n${p.entries.map((e) => `- \`${e.identifier}\`${e.screen ? ` (${e.screen})` : ''}`).join('\n')}\n\nFiles: ${proposalFiles.map((f) => `\`${f}\``).join(', ')}`,
    });
    // restore (F2 ordering): back to main, pop stash best-effort, clear LAST
    git('checkout', '-q', 'main');
    if (toStash.length) {
      try { git('stash', 'pop'); } catch { stashKept = true; }
    }
    deps.db.prepare('DELETE FROM identifier_proposals WHERE session_id = ?').run(p.session_id);
    return { note: `${proposalFiles.length} file(s) committed on ${branch} — ${pr.url}${stashKept ? ' · STASH KEPT (pop conflicted — restore manually: git stash list)' : ''}` };
  } catch (err) {
    // park honestly; keep edits; never drop the stash
    const msg = err instanceof Error ? err.message : String(err);
    try { git('checkout', '-q', 'main'); } catch { /* already somewhere safe */ }
    deps.db.prepare("UPDATE identifier_proposals SET state = 'in-place-failed' WHERE session_id = ?").run(p.session_id);
    throw new Error(`${msg} (edits preserved${toStash.length ? ' + stash kept' : ''} at ${clonePath})`);
  }
}
