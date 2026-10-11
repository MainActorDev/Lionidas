/** Agent context (breakdown steps_004 §4b): built once in buildApp, same
 *  lifecycle as other deps. Provider: env-configured OpenAI-compatible, or
 *  the honest MockProvider when env is absent. */
import {
  MockProvider,
  OpenAICompatProvider,
  SqliteStorage,
  StorageRetriever,
  claudeCliProvider,
  type Provider,
} from '@mainactordev/butler';
import type Database from 'better-sqlite3';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { buildToolRegistry } from './tools.ts';
import { AttachmentStore } from './attachments.ts';
import { registerJiraTools } from './jira-refs.ts';
import { registerDraftTools } from './draft-tools.ts';
import { V1_POLICY } from './policy.ts';
import { LIONIDAS_SYSTEM_PROMPT } from './system-prompt.ts';

export interface AgentContext {
  storage: SqliteStorage;
  retriever: StorageRetriever;
  registry: ReturnType<typeof buildToolRegistry>;
  provider: Provider;
  policy: typeof V1_POLICY;
  systemPrompt: string;
  artifactsDir: string;
  /** true when a real provider is env-configured; false = mock (honest flag) */
  providerConfigured: boolean;
  /** boot-time source seeding (await in tests/drills; never blocks boot) */
  seedPromise: Promise<{ documents: number; skipped: number }>;
  /** how many times preset writes synced the live forge proxy (F2 observability) */
  syncPresetsCalls: number;
  /** rev23 F2: attachment store (sha-deduped files + manifest) */
  attachments: AttachmentStore;
}

/** claude --mcp-config JSON: one stdio server = the Lionidas registry. */
function writeMcpConfig(env: Record<string, string | undefined>): string {
  const script = new URL('./mcp-stdio.sh', import.meta.url).pathname;
  const cfg = { mcpServers: { lionidas: { command: '/bin/bash', args: [script], env: { ...(env['CRUCIBLE_DB_PATH'] ? { CRUCIBLE_DB_PATH: env['CRUCIBLE_DB_PATH'] } : {}) } } } };
  const path = join(cfg_artifactsDir(env), 'claude-mcp.json');
  writeFileSync(path, JSON.stringify(cfg, null, 2));
  return path;
}
function cfg_artifactsDir(env: Record<string, string | undefined>): string {
  return env['CRUCIBLE_ARTIFACTS_DIR'] ?? './artifacts';
}

export function buildAgentContext(db: Database.Database, cfg: { dbPath: string; artifactsDir: string; env: Record<string, string | undefined>; syncPresets?: () => void }): AgentContext {
  const storage = new SqliteStorage(join(cfg.dbPath + '.agent.db'));
  const retriever = new StorageRetriever(storage);
  // observability: preset-proxy sync count (tests + future metrics). The wrap
  // happens BEFORE the registry build so every tool closure shares the counter.
  const syncState = { calls: 0 };
  const syncPresets = cfg.syncPresets
    ? (): void => { syncState.calls += 1; cfg.syncPresets!(); }
    : undefined;
  const attachments = new AttachmentStore(db, cfg.artifactsDir);
  const registry = buildToolRegistry({ db, storage, retriever, artifactsDir: cfg.artifactsDir, attachments, ...(syncPresets ? { syncPresets } : {}) });
  registerJiraTools(registry, cfg.env);
  registerDraftTools({ db, storage, retriever, registry, artifactsDir: cfg.artifactsDir });

  const baseUrl = cfg.env['BUTLER_PROVIDER_BASE_URL'];
  const apiKey = cfg.env['BUTLER_API_KEY'];
  const model = cfg.env['BUTLER_MODEL'];
  const providerKind = cfg.env['BUTLER_PROVIDER'] ?? 'openai-compat';
  let provider: Provider;
  let providerConfigured = false;
  if (providerKind === 'claude-cli') {
    // claude-cli middleware with a GLM backend: injects the Anthropic-protocol
    // endpoint vars into the SUBPROCESS only (host claude config untouched).
    const env: Record<string, string> = {};
    if (baseUrl && apiKey) {
      env['ANTHROPIC_BASE_URL'] = baseUrl.includes('/api/anthropic') ? baseUrl : 'https://api.z.ai/api/anthropic';
      env['ANTHROPIC_AUTH_TOKEN'] = apiKey;
      env['API_TIMEOUT_MS'] = '3000000';
    }
    provider = claudeCliProvider({
      kind: 'claude-cli',
      baseUrl: env['ANTHROPIC_BASE_URL'] ?? '',
      apiKey: env['ANTHROPIC_AUTH_TOKEN'] ?? '',
      model: model ?? 'glm-5.3-flash',
      ...(cfg.env['BUTLER_CLAUDE_BIN'] ? { binPath: cfg.env['BUTLER_CLAUDE_BIN'] } : {}),
      env,
      // rev13: mount the Lionidas registry as real MCP tools — the model calls
      // cases.list / run.triage.get / evidence.get instead of Bash+sqlite3.
      // mcp-stdio.sh sources .env (incl. LIONIDAS_PAT) itself.
      mcpConfigPath: writeMcpConfig(cfg.env),
    });
    providerConfigured = Boolean(baseUrl && apiKey);
  } else if (baseUrl && apiKey && model) {
    provider = new OpenAICompatProvider({ baseUrl, apiKey, model });
    providerConfigured = true;
  } else {
    provider = new MockProvider([{ kind: 'assistant', content: 'agent provider not configured (set BUTLER_PROVIDER_BASE_URL / BUTLER_API_KEY / BUTLER_MODEL) — mock response' }]);
  }

  const ctx: AgentContext = { storage, retriever, registry, provider, policy: V1_POLICY, systemPrompt: LIONIDAS_SYSTEM_PROMPT, artifactsDir: cfg.artifactsDir, providerConfigured, seedPromise: Promise.resolve({ documents: 0, skipped: 0 }), syncPresetsCalls: 0, attachments };

  Object.defineProperty(ctx, 'syncPresetsCalls', { get: () => syncState.calls });

  // boot-time source seed (idempotent, content-addressed; repo seed off under vitest for speed)
  const seed = import('./sources.ts').then((m) => m.seedSources(ctx, process.env['VITEST'] === 'true' ? { repoRoot: '/nonexistent-repo-hermetic' } : undefined));
  ctx.seedPromise = seed;

  return ctx;
}
