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
    expect(readBuildManifest(dir)).toEqual({ scheme: 'MyApp', configuration: 'Staging' });
  });

  it('valid: partial (scheme only), trimmed values', () => {
    manifest('build:\n  scheme: "  MyApp  "\n');
    expect(readBuildManifest(dir)).toEqual({ scheme: 'MyApp', configuration: null });
  });

  it('valid: explicit nulls and empty build map', () => {
    manifest('build:\n  scheme: null\n');
    expect(readBuildManifest(dir)).toEqual({ scheme: null, configuration: null });
    manifest('build:\n');
    expect(readBuildManifest(dir)).toEqual({ scheme: null, configuration: null });
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
