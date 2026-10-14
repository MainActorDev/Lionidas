/** Command registry — the SINGLE source of truth for slash commands
 *  (plan 20261013T144145Z: commands are CHAT TURNS with an instruction
 *  overlay — the Claude Code skill model). Everything reads this: the
 *  /api/agent/commands endpoint, the chat route's turn composition, and the
 *  web palette/bubbles.
 *
 *  CR1 (review): `instructions` is the COMMAND body only. AUTHOR's pipeline
 *  prompt embeds LIONIDAS_SYSTEM_PROMPT — stripped here; the turn builder
 *  composes the base exactly once. */
import type { FastifyInstance } from 'fastify';
import { requireRoleAtLeast } from '../auth/roles.ts';

export interface CommandSpec {
  cmd: string;              // '/planning'
  description: string;      // palette row subtitle
  /** engine chain position — multi-command sorts by this (planning → breakdown → author) */
  order: number;
  /** the command's instruction body (command-specific ONLY — no base prompt) */
  instructions: string;
  /** optional tool narrowing (INTERSECTS the chat turn's permission envelope — CR3) */
  tools?: string[];
}

export const COMMANDS: CommandSpec[] = [
  {
    cmd: '/planning',
    description: 'Plan test cases from a request',
    order: 1,
    tools: ['cases.list', 'case.yaml.get', 'runs.history', 'screens.registry', 'folders.tree', 'sources.search', 'notes.read', 'repo.read', 'repo.tree', 'repo.commit_files', 'repo.diff'],
    instructions: `You are executing the /planning command for this turn. Produce the SCOPE of testing for what the user asked.

Your output is a scope document (markdown) with exactly these sections:
## In scope — what to test, one line per area, each traceable to a ref
## Out of scope — what NOT to test and why
## Risks — where breakage is likely (new flows, changed selectors, env gates)
## Acceptance criteria — the Given/When/Then lines the cases must prove

Rules:
- Ground EVERY claim in the refs/knowledge available (tools are truth); cite ref ids like [CUST-101].
- If the knowledge is insufficient to scope the work, ASK IN THE THREAD — a short numbered list of questions; the user replies in chat.
- Read existing notes (conventions, pitfalls) — they are prior knowledge; do not contradict them without flagging why.`,
  },
  {
    cmd: '/breakdown',
    description: 'Break a plan into concrete steps',
    order: 2,
    tools: ['cases.list', 'case.yaml.get', 'folders.tree', 'notes.read'],
    instructions: `You are executing the /breakdown command for this turn. Organize the scope (from the conversation, or the user's ask) into CASES.

Your output is a breakdown table (markdown) with columns: case name | folder | why this case | AC it proves.
Rules:
- Organize by folder paths that FIT the app's existing structure (read folders.tree and cases.list first — dedupe against existing cases; a case that already exists and still passes its ACs is NOT re-authored).
- One case per behavior, not per screen. Merge trivial variants into variants of a case, not new cases.
- Names are lowercase imperative ("login with valid pin", "checkout rejects expired card").
- If the plan is ambiguous, ASK IN THE THREAD before inventing cases.`,
  },
  {
    cmd: '/author',
    description: 'Author case YAML drafts',
    order: 3,
    instructions: `You are executing the /author command for this turn. Write the cases from the breakdown in the conversation (or the user's ask).
- Write each case as yaml through case.draft.save (the validator is ground truth — never claim validity, the tool decides; fix per its verbatim errors and retry once).
- Place cases in the folders the breakdown assigned (folders may be created on save).
- For every control lacking an accessibility identifier, save a selector-trust note (scope app:<bundle>/screen:<screen>) — the app team's runbook.
- After saving, list the case ids you created.
- If the breakdown is missing (nothing to author from), ASK IN THE THREAD for the cases or a plan first.`,
  },
  {
    cmd: '/implement-identifiers',
    description: 'Implement missing accessibility identifiers in the app repo (worktree → PR)',
    order: 4,
    tools: ['cases.list', 'case.yaml.get', 'case.validate', 'screens.registry', 'folders.tree', 'sources.search', 'notes.read', 'note.save', 'repo.read', 'repo.tree', 'repo.apps', 'repo.list'],
    instructions: `You are executing the /implement-identifiers command for this turn. Missing accessibility identifiers blocked case creation; this turn IMPLEMENTS them in the app codebase.

Workflow — follow exactly, with a HARD STOP:
1. GATHER the missing identifiers from the thread (the gate error names them) or re-run case.validate on the parked yaml. If neither exists, ASK IN THE THREAD.
2. PROPOSE: for each identifier — target file (screen registry + repo.read/repo.tree of the app repo), the exact control (match by label text or view structure), the exact line to insert (SwiftUI .accessibilityIdentifier(...) or UIKit assignment), and a RECOMMENDED name following the app's dominant convention (e.g. account_, btn_). Render a markdown table: identifier | file | control | insert line | evidence.
3. HARD STOP: end your turn with the table and the question "Confirm implementing these N identifiers? (all / pick numbers)". Do NOT create anything before the user replies. The host only builds the worktree after your proposal AND the user's confirmation.
4. After user confirmation (next turn), the host creates a git worktree from origin/develop and you edit files INSIDE it: repo.read the targets, insert the identifier lines at the exact proposed spots. You CANNOT run git, push, or open PRs — the host does that after your edits.
5. Report the edits as a list (file + line + identifier), then save the parked case yaml as a note (kind author-parked, scope case) if not already parked, so the case resumes after merge + reindex.

Rules:
- Names are RECOMMENDATIONS following the app's convention — never invent novel patterns.
- NEVER fall back to coordinates because an identifier is hard to place; ask instead.
- One identifier per control; do not touch unrelated code; no refactors.
- If the target repo has no compile CI on PRs, say so in your report — the user decides the gate.`,
  },
  {
    cmd: '/recipe-propose',
    description: 'Propose a build recipe for an unclassifiable or blocked repo',
    order: 5,
    tools: ['repo.list', 'repo.apps', 'repo.tree', 'repo.read', 'sources.search', 'notes.read', 'note.save'],
    instructions: `You are executing the /recipe-propose command for this turn. The project's build recipe detection returned blocked (or unclassifiable); this turn PROPOSES a recipe — you never write it.

Workflow — follow exactly, with a HARD STOP:
1. READ the project workspace via repo tools (repo.tree / repo.read): build files (project.yml, Package.swift, Project.swift, Podfile, *.xcodeproj/workspace, fastlane/Fastfile), config wiring (xcconfig paths and whether they exist), scripts, CI workflows. Use sources.search when the repo is large.
2. CLASSIFY the archetype and DIAGNOSE each blocker from the detection report (it names codes with evidence).
3. PROPOSE a markdown table: transport (repo-lane|generic) | scheme | configuration | prepare steps (ordered, exact commands) — and for EVERY row a file:line evidence citation. If a blocker is a MISSING SECRET or credential you cannot read (gitignored xcconfig, private spec repo, signing), that row is the blocker NEEDS_SECRETS — the HUMAN supplies it; never propose synthesizing or bypassing a secret.
4. HARD STOP: end your turn with the table and "Confirm applying this recipe? The host writes it (provenance: ai+user) and offers verify." Do NOT write anything before the user replies.
5. After confirmation (next turn), the HOST applies the recipe via POST /api/projects/:id/recipe/apply-proposal — say so and stop. Park the proposal as a note (kind recipe-proposal, scope project) if the user defers.

Rules:
- Every claim cites file:line. No evidence, no row.
- Secrets (certs, credentials, gitignored env configs) are a HUMAN gate — name them, never invent them.
- You never mark a recipe green; only verify-build (xcodebuild) decides that.`,
  },
  {
    cmd: '/recipe-diagnose',
    description: 'Diagnose a failed verify build and propose a recipe revision',
    order: 6,
    tools: ['repo.list', 'repo.apps', 'repo.tree', 'repo.read', 'sources.search', 'notes.read', 'note.save'],
    instructions: `You are executing the /recipe-diagnose command for this turn. A verify build FAILED against the active recipe; this turn diagnoses the failure log and PROPOSES a recipe revision — you never write it.

Workflow — follow exactly, with a HARD STOP:
1. READ the failure: the recipe's verify log (the user pastes it or it rides the thread) — find the FIRST hard error (xcodebuild, xcodegen, prepare step, resolution).
2. CORROBORATE against the repo via repo.read at the exact file:line the error names — a diagnosis without code corroboration is a guess.
3. PROPOSE the minimal revision as a table: what changes (scheme | configuration | prepare step added/edited/removed) | why (the error it fixes) | evidence (file:line from BOTH the log and the repo).
4. HARD STOP: end with the table and "Confirm applying this revision? The host writes it (revision N+1, provenance: ai+user); then re-run verify." Do NOT write anything before the user replies.
5. After confirmation, the HOST applies the revision and the user re-runs verify — say so and stop. One revision per confirmation; no retry loops.

Rules:
- Root cause, not symptom: if the log's error is downstream (missing generated project), the revision fixes the UPSTREAM prepare step.
- Every row cites log line + file:line. Secrets are a HUMAN gate (NEEDS_SECRETS) — never proposed around.
- You never decide green; xcodebuild does.`,
  },
];

export const commandByCmd = (cmd: string): CommandSpec | undefined => COMMANDS.find((c) => c.cmd === cmd);

/** engine order regardless of typing order (deduped) */
export function orderCommands(cmds: string[]): CommandSpec[] {
  return [...COMMANDS].filter((c) => cmds.includes(c.cmd)).sort((a, b) => a.order - b.order);
}

/** CR3: intersect, never expand */
export function toolsFor(cmds: CommandSpec[], envelope: string[]): string[] | null {
  const withTools = cmds.filter((c) => c.tools?.length);
  if (!withTools.length) return null;
  const wanted = new Set(withTools.flatMap((c) => c.tools ?? []));
  const narrowed = envelope.filter((t) => wanted.has(t));
  return narrowed.length ? narrowed : null;
}

/** the turn's overlay block (base prompt composes ONCE outside this) */
export function overlayBlock(cmds: CommandSpec[]): string {
  return cmds.map((c) => `\n\n--- COMMAND ${c.cmd} ACTIVE — follow these instructions for this turn ---\n${c.instructions}`).join('');
}

export function registerCommandRoutes(app: FastifyInstance): void {
  app.get('/api/agent/commands', { preHandler: requireRoleAtLeast('operator') }, async () => ({
    commands: COMMANDS.map(({ cmd, description, order }) => ({ cmd, description, order })),
  }));
}
