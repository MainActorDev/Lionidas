/** Build-config apply bridge (plan 20261015T121500Z B1, review R1/R2/R5):
 *  closes the chat-confirmed-but-never-written gap — the third live occurrence
 *  (Foodiary ×2, ios-consumer) parked proposals as notes nobody read.
 *
 *  THE GATE (R1 — structural, not prompt-trust): the pending→applied flip
 *  happens in the butler prepareTurn decoration, driven by the user's NEXT
 *  message matching CONFIRM_RE — BEFORE the model sees the turn. The
 *  build_config.apply tool can only succeed on an ALREADY-flipped row; a model
 *  calling it on 'pending' is refused. The model can never flip the state.
 *
 *  PARKING (R2 — dual-layer): canonical = the build_config.propose tool's
 *  structured args; fallback = the answer-level detector (answer's yaml block),
 *  so a prose-only turn never dead-ends.
 *
 *  Keyed per (session, project) — R5: multi-project sessions. */
import type Database from 'better-sqlite3';

export interface BridgeProposal {
  transport: 'repo-lane' | 'generic';
  scheme: string | null;
  configuration: string | null;
  prepare: Array<{ run: string }>;
  evidence: string[];
}

export interface ParkedRow {
  sessionId: string;
  projectId: string;
  proposal: BridgeProposal;
  createdAt: number;
  state: 'pending' | 'applied' | 'declined';
}

/** same semantics as the identifier flow — bare words only */
const CONFIRM_RE = /^\s*(all|yes|y|go|ok|confirm|confirmed|do it|go for it|proceed|apply|apply it|apply the revision)\b/i;
const DECLINE_RE = /^\s*(no|n\b|cancel|stop|discard|skip|never\s*mind|abort)\b/i;

function rowToParked(r: { session_id: string; project_id: string; proposal_json: string; created_at: number; state: ParkedRow['state'] }): ParkedRow {
  let proposal: BridgeProposal = { transport: 'generic', scheme: null, configuration: null, prepare: [], evidence: [] };
  try {
    const parsed = JSON.parse(r.proposal_json) as Partial<BridgeProposal>;
    proposal = {
      transport: parsed.transport === 'repo-lane' ? 'repo-lane' : 'generic',
      scheme: parsed.scheme ?? null,
      configuration: parsed.configuration ?? null,
      prepare: Array.isArray(parsed.prepare) ? parsed.prepare : [],
      evidence: Array.isArray(parsed.evidence) ? parsed.evidence : [],
    };
  } catch { /* keep default */ }
  return { sessionId: r.session_id, projectId: r.project_id, proposal, createdAt: r.created_at, state: r.state };
}

export function parkProposal(db: Database.Database, sessionId: string, projectId: string, proposal: BridgeProposal): void {
  db.prepare(`INSERT OR REPLACE INTO build_config_proposals(session_id, project_id, proposal_json, created_at, state)
              VALUES (?,?,?,?, 'pending')`)
    .run(sessionId, projectId, JSON.stringify(proposal), Date.now());
}

export function getParked(db: Database.Database, sessionId: string, projectId: string): ParkedRow | null {
  const r = db.prepare('SELECT * FROM build_config_proposals WHERE session_id = ? AND project_id = ?').get(sessionId, projectId) as
    { session_id: string; project_id: string; proposal_json: string; created_at: number; state: ParkedRow['state'] } | undefined;
  return r ? rowToParked(r) : null;
}

export function listParkedForSession(db: Database.Database, sessionId: string): ParkedRow[] {
  return (db.prepare('SELECT * FROM build_config_proposals WHERE session_id = ?').all(sessionId) as Array<{ session_id: string; project_id: string; proposal_json: string; created_at: number; state: ParkedRow['state'] }>).map(rowToParked);
}

export function isConfirmation(content: string): boolean { return CONFIRM_RE.test(content); }
export function isDecline(content: string): boolean { return DECLINE_RE.test(content); }

/** R2 fallback detector: does an assistant answer look like a build-config
 *  proposal ending in the mandated hard-stop question? Extracts the yaml block. */
export function proposalFromAnswer(answer: string): BridgeProposal | null {
  if (!/confirm (applying|this)\b/i.test(answer) && !/hard stop/i.test(answer)) return null;
  const m = /```yaml\n([\s\S]*?)```/.exec(answer);
  if (!m) return null;
  const yaml = m[1]!;
  const pick = (key: string): string | null => {
    const km = new RegExp(`^\\s*${key}:\\s*(.+)$`, 'm').exec(yaml);
    return km ? km[1]!.trim().replace(/^["']|["']$/g, '') : null;
  };
  const transport = pick('transport') === 'repo-lane' ? 'repo-lane' as const : 'generic' as const;
  const scheme = pick('scheme');
  const configuration = pick('configuration');
  const prepare: Array<{ run: string }> = [];
  const prepBlock = /prepare:\n([\s\S]*?)(?=\n\s*\w+:|$)/.exec(yaml);
  if (prepBlock) {
    for (const line of prepBlock[1]!.split('\n')) {
      const rm = /^\s*-\s*(?:run:\s*)?(?:>-?\s*)?(.+)$/.exec(line);
      if (rm) {
        const run = rm[1]!.trim();
        // skip gate/guard/build pseudo-steps the prose yaml carries — only real run commands park
        if (run && !/^(gate:|guard:|build:)/.test(run) && !run.startsWith('#')) prepare.push({ run });
      }
    }
  }
  return { transport, scheme, configuration, prepare, evidence: ['parked via answer-detector fallback (R2)'] };
}

/** the prepareTurn-side flip (R1): called with the user's next message content;
 *  flips pending→applied for every pending project row when the message is a
 *  bare confirmation; declines clear. Returns the flipped rows so the turn
 *  overlay can tell the model WHICH projects were confirmed.
 *
 *  SESSION-ID BRIDGE (live drill catch): tools invoked through the MCP child
 *  (mcp__lionidas__*) park under the child's placeholder id ('mcp-stdio'), not
 *  the chat session — the child's ToolContext cannot see the chat id. The
 *  confirmation flip therefore matches pending rows for the SAME PROJECT parked
 *  recently (default 30 min) from ANY session: the chat that proposes is the
 *  chat that confirms; the child 'session' is an artifact, never an actor. The
 *  gate stays structural — only this seam flips, only on the user's message. */
export function consumeConfirmation(db: Database.Database, sessionId: string, userContent: string, opts?: { recencyMs?: number }): ParkedRow[] {
  const recency = opts?.recencyMs ?? 30 * 60_000;
  const own = listParkedForSession(db, sessionId).filter((r) => r.state === 'pending');
  const foreign = (db.prepare(`SELECT * FROM build_config_proposals WHERE state = 'pending' AND session_id != ? AND created_at > ?`)
    .all(sessionId, Date.now() - recency) as Array<{ session_id: string; project_id: string; proposal_json: string; created_at: number; state: ParkedRow['state'] }>)
    .map(rowToParked)
    // a project already parked by THIS session is owned by this session
    .filter((r) => !own.some((x) => x.projectId === r.projectId));
  const pending = [...own, ...foreign];
  if (!pending.length) return [];
  if (isDecline(userContent)) {
    const upd = db.prepare("UPDATE build_config_proposals SET state = 'declined' WHERE session_id = ? AND project_id = ?");
    for (const r of pending) upd.run(r.sessionId, r.projectId);
    return [];
  }
  if (!isConfirmation(userContent)) return []; // a question keeps it pending
  const upd = db.prepare("UPDATE build_config_proposals SET state = 'applied' WHERE session_id = ? AND project_id = ?");
  const flipped: ParkedRow[] = [];
  for (const r of pending) { upd.run(r.sessionId, r.projectId); flipped.push({ ...r, state: 'applied' }); }
  return flipped;
}
