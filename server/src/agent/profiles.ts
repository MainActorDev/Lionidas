/** P2 — the three author-pipeline agent profiles (plan 20261010T173500Z).
 *  Executors are CONFIG (operator decision 2026-10-10): each profile reads
 *  its provider from env, defaulting to the shared agent provider, falling
 *  back to mock (hermetic CI). Memory scopes per profile (Butler D6a):
 *  planner/breaker read app conventions + pitfalls; author additionally
 *  reads per-screen selector-trust notes. */
import type { AgentProfile, ExecutorConfig, ScriptedTurn } from '@mainactordev/butler';
import { LIONIDAS_SYSTEM_PROMPT } from './system-prompt.ts';

const PLANNER_PROMPT = `You are the Lionidas test PLANNER. You receive a compiled knowledge document (ticket refs, PR diffs, docs, code symbols — each with provenance) and produce the SCOPE of testing.

Your output is a scope document (markdown) with exactly these sections:
## In scope — what to test, one line per area, each traceable to a ref
## Out of scope — what NOT to test and why
## Risks — where breakage is likely (new flows, changed selectors, env gates)
## Acceptance criteria — the Given/When/Then lines the cases must prove

Rules:
- Ground EVERY claim in the knowledge document; cite ref ids like [DEMO-101].
- If the knowledge is insufficient to scope the work, output a question payload instead: {"type":"question","questions":[{"id":"...","text":"..."}]} — the pipeline will pause and a human answers.
- Read existing notes (conventions, pitfalls) — they are prior knowledge; do not contradict them without flagging why.`;

const BREAKER_PROMPT = `You are the Lionidas test BREAKER. You receive the scope document and organize it into CASES.

Your output is a breakdown table (markdown) with columns: case name | folder | why this case | AC it proves.
Rules:
- Organize by folder paths that FIT the app's existing structure (read folders.tree and cases.list first — dedupe against existing cases; a case that already exists and still passes its ACs is NOT re-authored).
- One case per behavior, not per screen. Merge trivial variants into variants of a case, not new cases.
- Names are lowercase imperative ("login with valid pin", "checkout rejects expired card").`;

const AUTHOR_PROMPT = `${LIONIDAS_SYSTEM_PROMPT}

You are the AUTHOR stage. You receive the breakdown table and write the cases.
- Write each case as yaml through case.draft.save (the validator is ground truth — never claim validity, the tool decides; fix per its verbatim errors and retry once).
- Place cases in the folders the breakdown assigned (folders may be created on save).
- For every control lacking an accessibility identifier, save a selector-trust note (scope app:<bundle>/screen:<screen>) — the app team's runbook.
- After saving, list the case ids you created.`;

function executor(env: Record<string, string | undefined>, prefix: 'AGENT_PLANNER' | 'AGENT_BREAKER' | 'AGENT_AUTHOR', fallback: ExecutorConfig): ExecutorConfig {
  // rev23: BUTLER_PROVIDER=default only for openai-compat — the chat provider wraps
  // claude-cli in middleware (GLM translation) that the pipeline executor cannot reuse,
  // so claude-cli stays opt-in per stage via AGENT_*_PROVIDER. A missing AGENT_*_PROVIDER
  // must not silently drop the pipeline onto the mock executor.
  const globalKind = env['BUTLER_PROVIDER'] === 'claude-cli' ? 'openai-compat' : (env['BUTLER_PROVIDER'] ?? '');
  const kind = (env[`${prefix}_PROVIDER`] ?? globalKind) as ExecutorConfig['kind'] | '';
  if (!kind || kind === 'mock') return fallback; // mock/hermetic: same scripted fallback
  if (kind === 'claude-cli') {
    return { kind, baseUrl: '', apiKey: '', model: env[`${prefix}_MODEL`] ?? 'claude-sonnet-4-5', policyClass: 'draft', ...(env['AGENT_CLAUDE_BIN'] ? { binPath: env['AGENT_CLAUDE_BIN'] } : {}) };
  }
  // openai-compat
  const baseUrl = env[`${prefix}_BASE_URL`] ?? env['BUTLER_PROVIDER_BASE_URL'] ?? '';
  const apiKey = env[`${prefix}_API_KEY`] ?? env['BUTLER_API_KEY'] ?? '';
  const model = env[`${prefix}_MODEL`] ?? env['BUTLER_MODEL'] ?? '';
  if (!baseUrl || !apiKey || !model) return fallback;
  return { kind: 'openai-compat', baseUrl, apiKey, model };
}

export interface ProfileBundle {
  planner: AgentProfile;
  breaker: AgentProfile;
  author: AgentProfile;
}

/** Build the three profiles. memoryScopes need the bundle id — the pipeline
 *  provides it (it knows the refs' app). Scripts power hermetic tests. */
export function buildProfiles(env: Record<string, string | undefined>, opts: { appBundle: string; mockScripts?: { planner?: ScriptedTurn[]; breaker?: ScriptedTurn[]; author?: ScriptedTurn[] } }): ProfileBundle {
  const mock = (scripts?: ScriptedTurn[]): ExecutorConfig =>
    ({ kind: 'mock', baseUrl: '', apiKey: '', model: 'mock', ...(scripts ? { mockScript: scripts } : {}) });
  return {
    planner: {
      id: 'lionidas.planner',
      systemPrompt: PLANNER_PROMPT,
      tools: ['cases.list', 'case.yaml.get', 'runs.history', 'screens.registry', 'folders.tree', 'sources.search', 'notes.read', 'repo.read', 'repo.tree', 'repo.commit_files', 'repo.diff'],
      policy: 'read',
      provider: executor(env, 'AGENT_PLANNER', mock(opts.mockScripts?.planner)),
      budgets: { maxHops: 10 },
      memoryScopes: [`app:${opts.appBundle}/*`],
    },
    breaker: {
      id: 'lionidas.breaker',
      systemPrompt: BREAKER_PROMPT,
      tools: ['cases.list', 'case.yaml.get', 'folders.tree', 'notes.read'],
      policy: 'read',
      provider: executor(env, 'AGENT_BREAKER', mock(opts.mockScripts?.breaker)),
      budgets: { maxHops: 8 },
      memoryScopes: [`app:${opts.appBundle}/*`],
    },
    author: {
      id: 'lionidas.author',
      systemPrompt: AUTHOR_PROMPT,
      tools: ['cases.list', 'case.yaml.get', 'screens.registry', 'folders.tree', 'notes.read', 'sources.search', 'case.draft.save', 'case.draft.edit', 'note.save', 'sources.ingest', 'repo.read', 'repo.tree', 'repo.commit_files', 'repo.diff'],
      policy: 'draft',
      provider: executor(env, 'AGENT_AUTHOR', mock(opts.mockScripts?.author)),
      budgets: { maxHops: 14 },
      memoryScopes: [`app:${opts.appBundle}/*`],
    },
  };
}
