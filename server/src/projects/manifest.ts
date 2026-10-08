/** lionidas.yml — the repo-declared build manifest (plan 20261007T164500Z T2).
 *
 *  v2 shape (strict):
 *    build:
 *      scheme: <string>        # optional
 *      configuration: <string> # optional
 *    prepare:                  # optional, ordered; runs BEFORE the build
 *      - run: <command string> # first word must be an existing relative path
 *                              # inside the repo (repo-owned script)
 *
 *  The repo owns setup knowledge in its own scripts (bootstrap.sh,
 *  xcodebuild_cached.sh …) — Lionidas NEVER re-implements setup; it runs
 *  what the repo declares. Trust model: identical to a repo lane script —
 *  building a repo means running its code; the manifest is data declaring
 *  which script, and scripts get no secret injection.
 *
 *  STRICT SCHEMA: unknown keys, wrong types, out-of-repo paths →
 *  ManifestError (code MANIFEST_INVALID, the offending part named). A repo
 *  that speaks must be heard — a typo never silently runs nothing. Absent
 *  file → null (normal path). */
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { parse as parseYaml } from 'yaml';

export const MANIFEST_FILENAME = 'lionidas.yml';

export interface PrepareStep {
  run: string;
}

export interface BuildManifest {
  scheme: string | null;
  configuration: string | null;
  prepare: PrepareStep[];
}

export class ManifestError extends Error {
  readonly code = 'MANIFEST_INVALID' as const;
  constructor(reason: string) {
    super(`lionidas.yml: ${reason}`);
  }
}

/** A prepare command's first word must be a repo-relative path (no absolute,
 *  no ..). Existence is validated at RUN time against the workspace. */
export function prepareCommandPath(cmd: string): string {
  const first = cmd.trim().split(/\s+/)[0] ?? '';
  if (first === '') throw new ManifestError('prepare run command is empty');
  if (isAbsolute(first)) throw new ManifestError(`prepare run "${first}" must be a path inside the repo, not absolute`);
  if (first.split('/').includes('..')) throw new ManifestError(`prepare run "${first}" must not escape the repo`);
  return first;
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
    if (k !== 'build' && k !== 'prepare') throw new ManifestError(`unknown key "${k}" (allowed: build, prepare)`);
  }
  const out: BuildManifest = { scheme: null, configuration: null, prepare: [] };
  const build = top['build'];
  if (build !== undefined && build != null) {
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
  }
  const prepare = top['prepare'];
  if (prepare !== undefined && prepare != null) {
    if (!Array.isArray(prepare)) throw new ManifestError('"prepare" must be a list');
    for (const [i, item] of prepare.entries()) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        throw new ManifestError(`prepare[${i}] must be a mapping with a "run" key`);
      }
      const keys = Object.keys(item as Record<string, unknown>);
      if (keys.length !== 1 || keys[0] !== 'run') {
        throw new ManifestError(`prepare[${i}] must have exactly one key "run" (got: ${keys.join(', ') || 'none'})`);
      }
      const run = (item as { run: unknown }).run;
      if (typeof run !== 'string' || run.trim() === '') {
        throw new ManifestError(`prepare[${i}].run must be a non-empty string`);
      }
      prepareCommandPath(run); // validates path shape (existence checked at run)
      out.prepare.push({ run: run.trim() });
    }
  }
  return out;
}
