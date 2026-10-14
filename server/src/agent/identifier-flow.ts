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
import { join } from 'node:path';
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
    state TEXT NOT NULL DEFAULT 'pending'
  )`);
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
}

export function makeTurnDecorator(deps: DecoratorDeps) {
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
      if (!isConfirm && !isDecline) return null;
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
    afterTurn: (sessionId: string, outcome: { ok: boolean; turnId: string; answer: string }): void => {
      const p = getProposal(deps.db, sessionId);
      if (p && p.state === 'confirmed') {
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
        setPending(deps.db, { session_id: sessionId, repo: 'ios-consumer-intl', slug, entries: uniq.map((identifier) => ({ identifier, screen: identifier.split('_')[0]!, })), created_at: Date.now() });
        deps.onAuto?.(`[implement-identifiers] proposal parked on ${sessionId}: ${uniq.length} identifiers — awaiting user confirmation`);
      }
    },
  };
}
