/** lionidas.yml — the repo-declared build manifest (plan 20261007T164500Z T2).
 *
 *  v1 shape (strict):
 *    build:
 *      scheme: <string>        # optional
 *      configuration: <string> # optional
 *
 *  STRICT SCHEMA: unknown keys (top-level or under build), non-string
 *  values, or malformed YAML → ManifestError (code MANIFEST_INVALID, the
 *  offending key named). A repo that speaks must be heard — a typo never
 *  silently falls through to guessing. Absent file → null (normal path).
 *
 *  Trust model: repo content is trusted (same trust as a repo lane script);
 *  the manifest is DATA, never executed. Platform-neutral by design —
 *  future android:/web: sections extend the same file; scheme maps to a
 *  Gradle module/flavor later, configuration to a variant. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

export const MANIFEST_FILENAME = 'lionidas.yml';

export interface BuildManifest {
  scheme: string | null;
  configuration: string | null;
}

export class ManifestError extends Error {
  readonly code = 'MANIFEST_INVALID' as const;
  constructor(reason: string) {
    super(`lionidas.yml: ${reason}`);
  }
}

/** Read + validate the manifest from a workspace clone. Absent → null. */
export function readBuildManifest(ws: string): BuildManifest | null {
  let raw: string;
  try {
    raw = readFileSync(join(ws, MANIFEST_FILENAME), 'utf8');
  } catch {
    return null; // absent — normal resolution path
  }
  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch (e) {
    throw new ManifestError(`malformed YAML (${e instanceof Error ? e.message.split('\n')[0] : String(e)})`);
  }
  if (doc == null) return null; // empty file ≡ absent
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    throw new ManifestError('top level must be a mapping');
  }
  const top = doc as Record<string, unknown>;
  for (const k of Object.keys(top)) {
    if (k !== 'build') throw new ManifestError(`unknown key "${k}" (only "build" is allowed)`);
  }
  const out: BuildManifest = { scheme: null, configuration: null };
  const build = top['build'];
  if (build === undefined) return out; // build: absent → both null (valid)
  if (build == null) return out; // `build:` with no children — vacuous, valid
  if (typeof build !== 'object' || Array.isArray(build)) {
    throw new ManifestError('"build" must be a mapping');
  }
  for (const [k, v] of Object.entries(build as Record<string, unknown>)) {
    if (k !== 'scheme' && k !== 'configuration') {
      throw new ManifestError(`unknown key "build.${k}" (allowed: scheme, configuration)`);
    }
    if (v === null || v === undefined) continue; // explicit null ≡ unset
    if (typeof v !== 'string' || v.trim() === '') {
      throw new ManifestError(`build.${k} must be a non-empty string`);
    }
    if (k === 'scheme') out.scheme = v.trim();
    else out.configuration = v.trim();
  }
  return out;
}
