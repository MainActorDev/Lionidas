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
