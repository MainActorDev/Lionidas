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
    cmd: '/build-config-propose',
    description: 'Propose a build config for an unclassifiable or blocked repo',
    order: 5,
    tools: ['repo.list', 'repo.apps', 'repo.tree', 'repo.read', 'sources.search', 'notes.read', 'note.save'],
    instructions: `You are executing the /build-config-propose command for this turn. The project's build recipe detection returned blocked (or unclassifiable); this turn PROPOSES a recipe — you never write it.

Workflow — follow exactly, with a HARD STOP:
1. READ the project workspace via repo tools (repo.tree / repo.read): build files (project.yml, Package.swift, Project.swift, Podfile, *.xcodeproj/workspace, fastlane/Fastfile), config wiring (xcconfig paths and whether they exist), scripts, CI workflows. Use sources.search when the repo is large.
2. CLASSIFY the archetype and DIAGNOSE each blocker from the detection report (it names codes with evidence).
3. WRITE AUTONOMOUSLY via build_config.write (projectId, transport, scheme, configuration, prepare[], evidence[]) — simulator-slice builds are agent territory (plan 20261015T164500Z): it writes the revision (provenance ai-auto) and fires verify in the same action. Render the table you wrote WITH its evidence citations in your report.
4. If the workspace is missing gitignored env-config files the build needs (*.xcconfig), call env_config.provision {projectId, files:[exact names]} FIRST — it copies them from registered on-machine sources (sha reported, contents never). If it returns ENV_CONFIG_NOT_FOUND, that is the human bootstrap: say exactly which files a human must place and where, and stop.
5. Verify fires automatically. If it fails: /build-diagnose-style revision (up to budgets). On VERIFY_BUDGET_EXHAUSTED or SAME_ERROR_LOOP, END THE TURN — report the last failure, what was tried, and when the budget resets. Distribution-grade actions (match/ASC/TestFlight) and repo PRs are NEVER autonomous — those remain the human's.

Rules:
- Every claim cites file:line. No evidence, no row.
- Secrets (certs, credentials, gitignored env configs) are a HUMAN gate — name them, never invent them.
- You never mark a recipe green; only verify-build (xcodebuild) decides that.`,
  },
  {
    cmd: '/build-diagnose',
    description: 'Diagnose a failed verify build and propose a build-config revision',
    order: 6,
    tools: ['repo.list', 'repo.apps', 'repo.tree', 'repo.read', 'sources.search', 'notes.read', 'note.save'],
    instructions: `You are executing the /build-diagnose command for this turn. A verify build FAILED against the active recipe; this turn diagnoses the failure log and PROPOSES a recipe revision — you never write it.

Workflow — follow exactly, with a HARD STOP:
1. READ the failure: the recipe's verify log (the user pastes it or it rides the thread) — find the FIRST hard error (xcodebuild, xcodegen, prepare step, resolution).
2. CORROBORATE against the repo via repo.read at the exact file:line the error names — a diagnosis without code corroboration is a guess.
3. WRITE the minimal revision AUTONOMOUSLY via build_config.write (the revised fields + evidence: file:line from BOTH the log and the repo) — it stamps ai-auto and re-fires verify. Root cause, not symptom: if the log's error is downstream (missing generated project), the revision fixes the UPSTREAM prepare step.
4. Missing env-config files → env_config.provision (exact *.xcconfig names). ENV_CONFIG_NOT_FOUND = human bootstrap; state it and stop.
5. Budgets are engine-enforced (3 revisions/hour, 3 verifies/hour, identical-error breaker). On VERIFY_BUDGET_EXHAUSTED or SAME_ERROR_LOOP: END THE TURN with the last failure and what was tried. Env-config placement the machine can't do, signing/distribution, and cross-repo PRs stay human.

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
