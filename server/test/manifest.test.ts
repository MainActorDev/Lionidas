import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readBuildManifest, MANIFEST_FILENAME } from '../src/projects/manifest.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mfst-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function manifest(content: string): void {
  writeFileSync(join(dir, MANIFEST_FILENAME), content);
}

describe('lionidas.yml manifest (strict)', () => {
  it('absent file → null', () => {
    expect(readBuildManifest(dir)).toBeNull();
  });

  it('valid: both keys', () => {
    manifest('build:\n  scheme: MyApp\n  configuration: Staging\n');
    expect(readBuildManifest(dir)).toEqual({ scheme: 'MyApp', configuration: 'Staging', prepare: [] });
  });

  it('valid: partial (scheme only), trimmed values', () => {
    manifest('build:\n  scheme: "  MyApp  "\n');
    expect(readBuildManifest(dir)).toEqual({ scheme: 'MyApp', configuration: null, prepare: [] });
  });

  it('valid: explicit nulls and empty build map', () => {
    manifest('build:\n  scheme: null\n');
    expect(readBuildManifest(dir)).toEqual({ scheme: null, configuration: null, prepare: [] });
    manifest('build:\n');
    expect(readBuildManifest(dir)).toEqual({ scheme: null, configuration: null, prepare: [] });
  });

  it('prepare: run steps parsed in order', () => {
    manifest('build:\n  scheme: App\nprepare:\n  - run: scripts/bootstrap.sh\n  - run: scripts/xcodebuild_cached.sh -resolvePackageDependencies\n');
    const m = readBuildManifest(dir);
    expect(m?.prepare).toEqual([
      { run: 'scripts/bootstrap.sh' },
      { run: 'scripts/xcodebuild_cached.sh -resolvePackageDependencies' },
    ]);
  });

  it('prepare: absolute path or .. escape → MANIFEST_INVALID', () => {
    manifest('prepare:\n  - run: /etc/bad.sh\n');
    expect(() => readBuildManifest(dir)).toThrow(/must be a path inside the repo/);
    manifest('prepare:\n  - run: ../outside.sh\n');
    expect(() => readBuildManifest(dir)).toThrow(/must not escape the repo/);
    manifest('prepare:\n  - run: scripts/../../x.sh\n');
    expect(() => readBuildManifest(dir)).toThrow(/must not escape the repo/);
  });

  it('prepare: wrong shape → MANIFEST_INVALID', () => {
    manifest('prepare: scripts/x.sh\n');
    expect(() => readBuildManifest(dir)).toThrow(/"prepare" must be a list/);
    manifest('prepare:\n  - scripts/x.sh\n');
    expect(() => readBuildManifest(dir)).toThrow(/must be a mapping with a "run" key/);
    manifest('prepare:\n  - run: x\n    extra: 1\n');
    expect(() => readBuildManifest(dir)).toThrow(/exactly one key "run"/);
  });

  it('unknown top-level key → MANIFEST_INVALID naming it', () => {
    manifest('build:\n  scheme: A\nandroid:\n  flavor: x\n');
    expect(() => readBuildManifest(dir)).toThrow(/unknown key "android"/);
  });

  it('unknown build key → MANIFEST_INVALID naming it', () => {
    manifest('build:\n  scheme: A\n  schemee: B\n');
    expect(() => readBuildManifest(dir)).toThrow(/build\.schemee/);
  });

  it('wrong value type → MANIFEST_INVALID', () => {
    manifest('build:\n  scheme: [a, b]\n');
    expect(() => readBuildManifest(dir)).toThrow(/must be a non-empty string/);
    manifest('build:\n  scheme: 42\n');
    expect(() => readBuildManifest(dir)).toThrow(/must be a non-empty string/);
  });

  it('malformed YAML → MANIFEST_INVALID', () => {
    manifest('build: [unclosed\n  scheme: A\n');
    expect(() => readBuildManifest(dir)).toThrow(/malformed YAML/);
  });

  it('empty file → null (≡ absent)', () => {
    manifest('');
    expect(readBuildManifest(dir)).toBeNull();
    manifest('\n# just a comment\n');
    expect(readBuildManifest(dir)).toBeNull();
  });
});

// keep imports used
void mkdirSync;
