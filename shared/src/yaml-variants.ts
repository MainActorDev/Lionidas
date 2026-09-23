/** Test variants (Phase B T1) — pure validation + env-merge rules.
 *
 *  A variant is ONE deterministic world for a case to run in: a network
 *  scenario (by NAME — scenarios.name is UNIQUE so resolution is total)
 *  plus a set of env values. The RUNNER expands variants in Phase C; this
 *  module is the format contract both phases share.
 *
 *  Rules follow the house format grammar: explicit body keys, no sigils,
 *  line-carrying errors, never a partial list. */
import type { YamlError } from './case-yaml.js';

export interface YamlVariant {
  id: string;
  networkScenario?: string;
  /** scenario SETS (S2): multiple scenarios compose; effective presets = union.
   *  Singular networkScenario stays as authoring sugar for [x]. */
  scenarios?: string[];
  env?: Record<string, string>;
}

/** Variant ids are code-ish identifiers: lowercase start, then letters,
 *  digits, underscore, dash. They become run labels (`case / id`) and
 *  query params — free text would need escaping in both. */
export const VARIANT_ID_RE = /^[a-z][a-z0-9_-]*$/;

/** Runaway guard, same spirit as the max-8 tags rule. */
export const MAX_VARIANTS = 12;

/** Parse + validate the raw `variants:` value. Returns null on ANY error
 *  (never a partial list) and pushes line-carrying errors. `variantN:`
 *  prefixes mirror the `step N:` convention so the editor's line-error
 *  surface renders them identically. */
export function parseVariants(raw: unknown, errors: YamlError[]): YamlVariant[] | null {
  if (!Array.isArray(raw)) {
    errors.push({ line: 1, message: 'variants must be a list (- id: …)' });
    return null;
  }
  if (raw.length === 0) {
    errors.push({ line: 1, message: 'variants, when present, needs at least one — remove the key if the case has no variants' });
    return null;
  }
  if (raw.length > MAX_VARIANTS) {
    errors.push({ line: 1, message: `too many variants (${raw.length}) — max is ${MAX_VARIANTS}` });
    return null;
  }
  const out: YamlVariant[] = [];
  const seen = new Map<string, number>(); // id → first index (1-based)
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push({ line: 1, message: `variant ${i + 1} must be a mapping (- id: …)` });
      continue;
    }
    const v = entry as Record<string, unknown>;
    // id
    const id = v['id'];
    if (typeof id !== 'string' || !VARIANT_ID_RE.test(id)) {
      errors.push({ line: 1, message: `variant ${i + 1}: id must match [a-z][a-z0-9_-]* (got ${JSON.stringify(id ?? null)})` });
      continue;
    }
    // unknown keys (checked BEFORE consuming known ones so typos surface)
    for (const k of Object.keys(v)) {
      if (k !== 'id' && k !== 'networkScenario' && k !== 'scenarios' && k !== 'env') {
        const hint = k === 'scenario' || k === 'network_scenario'
          ? ' — did you mean networkScenario?'
          : k === 'variables'
            ? ' — did you mean env?'
            : ` — allowed: id, networkScenario, scenarios, env`;
        errors.push({ line: 1, message: `variant ${i + 1}: unknown key "${k}"${hint}` });
      }
    }
    // S2: scenarios + networkScenario are mutually exclusive (one shape per variant)
    const hasSingular = v['networkScenario'] !== undefined;
    const hasPlural = v['scenarios'] !== undefined;
    if (hasSingular && hasPlural) {
      errors.push({ line: 1, message: `variant ${i + 1}: use either networkScenario or scenarios, not both` });
      continue;
    }
    // networkScenario
    const scenario = v['networkScenario'];
    if (scenario !== undefined && typeof scenario !== 'string') {
      errors.push({ line: 1, message: `variant ${i + 1}: networkScenario must be a scenario name (string)` });
      continue;
    }
    // scenarios (S2): list of scenario names, non-empty, no dups
    let scenarios: string[] | undefined;
    if (hasPlural) {
      const rawList = v['scenarios'];
      if (!Array.isArray(rawList) || rawList.length === 0 || rawList.some((x) => typeof x !== 'string')) {
        errors.push({ line: 1, message: `variant ${i + 1}: scenarios must be a non-empty list of scenario names` });
        continue;
      }
      const list = rawList as string[];
      const dup = list.find((x, j) => list.indexOf(x) !== j);
      if (dup !== undefined) {
        errors.push({ line: 1, message: `variant ${i + 1}: duplicate scenario "${dup}" in scenarios` });
        continue;
      }
      scenarios = list;
    }
    // env
    const envRaw = v['env'];
    let env: Record<string, string> | undefined;
    if (envRaw !== undefined && envRaw !== null) {
      if (typeof envRaw !== 'object' || Array.isArray(envRaw)
        || Object.entries(envRaw).some(([, val]) => typeof val !== 'string')) {
        errors.push({ line: 1, message: `variant ${i + 1}: env must be a map of strings (expected_title: "…")` });
        continue;
      }
      env = Object.fromEntries(Object.entries(envRaw).map(([k, val]) => [k, val as string]));
    }
    // duplicate ids (naming BOTH occurrences)
    if (seen.has(id)) {
      errors.push({ line: 1, message: `variant ${i + 1}: duplicate id "${id}" (also variant ${seen.get(id)})` });
      continue;
    }
    seen.set(id, i + 1);
    out.push({
      id,
      ...(typeof scenario === 'string' ? { networkScenario: scenario } : {}),
      ...(scenarios !== undefined ? { scenarios } : {}),
      ...(env !== undefined ? { env } : {}),
    });
  }
  return errors.length > 0 ? null : out;
}

/** Phase C precedence, settled NOW so both phases share one tested rule:
 *  variant env OVERRIDES invocation env (narrowest scope wins), disjoint
 *  keys union. A null variant is a passthrough. */
export function mergeVariantEnv(variant: YamlVariant | null, invocationEnv: Record<string, string>): Record<string, string> {
  if (!variant?.env) return { ...invocationEnv };
  return { ...invocationEnv, ...variant.env };
}

/** S2: the scenario NAMES a variant activates, in deterministic order —
 *  plural `scenarios` as authored, singular as `[x]`, none as []. This is
 *  the one accessor the runner uses; everything downstream (resolution,
 *  conflict detection, union application) consumes its output. */
export function variantScenarioNames(variant: YamlVariant | null): string[] {
  if (!variant) return [];
  if (variant.scenarios && variant.scenarios.length > 0) return [...variant.scenarios];
  if (variant.networkScenario) return [variant.networkScenario];
  return [];
}
