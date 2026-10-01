/** Agent context (breakdown steps_004 §4b): built once in buildApp, same
 *  lifecycle as other deps. Provider: env-configured OpenAI-compatible, or
 *  the honest MockProvider when env is absent. */
import {
  MockProvider,
  OpenAICompatProvider,
  SqliteStorage,
  StorageRetriever,
  type Provider,
} from '@mainactordev/butler';
import type Database from 'better-sqlite3';
import { join } from 'node:path';
import { buildToolRegistry } from './tools.ts';
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
}

export function buildAgentContext(db: Database.Database, cfg: { dbPath: string; artifactsDir: string; env: Record<string, string | undefined> }): AgentContext {
  const storage = new SqliteStorage(join(cfg.dbPath + '.agent.db'));
  const retriever = new StorageRetriever(storage);
  const registry = buildToolRegistry({ db, storage, retriever, artifactsDir: cfg.artifactsDir });
  registerDraftTools({ db, storage, retriever, registry, artifactsDir: cfg.artifactsDir });

  const baseUrl = cfg.env['BUTLER_PROVIDER_BASE_URL'];
  const apiKey = cfg.env['BUTLER_API_KEY'];
  const model = cfg.env['BUTLER_MODEL'];
  let provider: Provider;
  let providerConfigured = false;
  if (baseUrl && apiKey && model) {
    provider = new OpenAICompatProvider({ baseUrl, apiKey, model });
    providerConfigured = true;
  } else {
    provider = new MockProvider([{ kind: 'assistant', content: 'agent provider not configured (set BUTLER_PROVIDER_BASE_URL / BUTLER_API_KEY / BUTLER_MODEL) — mock response' }]);
  }

  const ctx: AgentContext = { storage, retriever, registry, provider, policy: V1_POLICY, systemPrompt: LIONIDAS_SYSTEM_PROMPT, artifactsDir: cfg.artifactsDir, providerConfigured, seedPromise: Promise.resolve({ documents: 0, skipped: 0 }) };

  // boot-time source seed (idempotent, content-addressed; repo seed off under vitest for speed)
  const seed = import('./sources.ts').then((m) => m.seedSources(ctx, process.env['VITEST'] === 'true' ? { repoRoot: '/nonexistent-repo-hermetic' } : undefined));
  ctx.seedPromise = seed;

  return ctx;
}
