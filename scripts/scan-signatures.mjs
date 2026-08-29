#!/usr/bin/env node
/**
 * Signature scan: this repo must contain ZERO references to the underlying
 * engine projects (same rule as Alloy — engine-neutrality is inherited).
 * Self-exempt; exit 1 on any hit.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SELF = fileURLToPath(import.meta.url);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage']);

const PATTERNS = [
  /argent/gi,
  /agent[-_]?device/gi,
  /callstack/gi,
  /swmansion/gi,
  /software[-_]?mansion/gi,
  /thatswiftdev/gi,
];

const TEXT_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md', '.txt', '.yaml', '.yml', '.vue', '.css', '.html', '']);

function* walk(dir) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) yield* walk(p);
    else if (ent.isFile()) yield p;
  }
}

const hits = [];
for (const file of walk(root)) {
  if (file === SELF) continue;
  const dot = file.lastIndexOf('.');
  const ext = dot === -1 ? '' : file.slice(dot);
  if (!TEXT_EXT.has(ext)) continue;
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { continue; }
  for (const re of PATTERNS) {
    re.lastIndex = 0;
    const m = re.exec(text);
    if (m) {
      hits.push(`${relative(root, file)}:${text.slice(0, m.index).split('\n').length}: ${re.source}`);
      break;
    }
  }
}

if (hits.length > 0) {
  console.error(`SIGNATURE SCAN FAILED — ${hits.length} hit(s):`);
  for (const h of hits) console.error('  ' + h);
  process.exit(1);
}
console.log('signature scan: CLEAN');
