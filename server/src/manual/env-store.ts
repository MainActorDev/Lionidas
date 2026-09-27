import type Database from 'better-sqlite3';

/** Managed env resolution (plan rev 2, Stage 2).
 *
 *  Values live in the env_vars table at three scopes — global, app:<bundle>,
 *  plan:<id> — and merge with the request-body env into the base that
 *  playback's activeEnv seeds from. Precedence (operator-confirmed
 *  2026-09-26, preserves the pinned variant-wins contract):
 *
 *      global < app < plan < request body < variant
 *
 *  Variant merging stays in yaml-variants.mergeVariantEnv — this module only
 *  builds the NON-variant base; the swap handler re-merges variants over
 *  `resolvedBase` (never over bare opts.env — review F1: rebuilding from the
 *  request body alone would drop every managed value mid-run).
 *
 *  Audit: resolveEnv also reports per-source counts so the run note can log
 *  `env sources: global(2) app(1) request(2)` — counts only, never values. */

export interface ResolveEnvArgs {
  appBundleId?: string | null;
  planId?: string | null;
  requestEnv?: Record<string, string>;
}

export interface ResolvedEnv {
  env: Record<string, string>;
  /** how many keys each source CONTRIBUTED to the final env (post-override) */
  sources: { global: number; app: number; plan: number; request: number };
  /** per-scope key→value maps BEFORE merging (route/debug use; never logged) */
  layers: { global: Record<string, string>; app: Record<string, string>; plan: Record<string, string> };
}

interface EnvVarRow {
  key: string;
  value: string;
}

export function resolveEnv(db: Database.Database, args: ResolveEnvArgs): ResolvedEnv {
  const { appBundleId = null, planId = null, requestEnv = {} } = args;

  const globalLayer: Record<string, string> = {};
  for (const r of db.prepare("SELECT key, value FROM env_vars WHERE scope = 'global'").all() as EnvVarRow[]) {
    globalLayer[r.key] = r.value;
  }
  const appLayer: Record<string, string> = {};
  if (appBundleId) {
    for (const r of db.prepare('SELECT key, value FROM env_vars WHERE scope = ? AND app_bundle_id = ?').all('app', appBundleId) as EnvVarRow[]) {
      appLayer[r.key] = r.value;
    }
  }
  const planLayer: Record<string, string> = {};
  if (planId) {
    for (const r of db.prepare('SELECT key, value FROM env_vars WHERE scope = ? AND plan_id = ?').all('plan', planId) as EnvVarRow[]) {
      planLayer[r.key] = r.value;
    }
  }

  // merge wide→narrow; track which source OWNS each key post-merge for counts
  const owner = new Map<string, 'global' | 'app' | 'plan' | 'request'>();
  const env: Record<string, string> = {};
  const apply = (layer: Record<string, string>, src: 'global' | 'app' | 'plan' | 'request'): void => {
    for (const [k, v] of Object.entries(layer)) {
      env[k] = v;
      owner.set(k, src);
    }
  };
  apply(globalLayer, 'global');
  apply(appLayer, 'app');
  apply(planLayer, 'plan');
  apply(requestEnv, 'request');

  const sources = { global: 0, app: 0, plan: 0, request: 0 };
  for (const src of owner.values()) sources[src] += 1;

  return { env, sources, layers: { global: globalLayer, app: appLayer, plan: planLayer } };
}
