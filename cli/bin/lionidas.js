#!/usr/bin/env node
/* lionidas bin — runs the TS source via the workspace tsx (dev-first: the CLI
 * is a workspace package; a compiled dist lands with packaging later). */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, 'runner.ts');
// tsx lives in cli/node_modules (pnpm workspace) — resolve its entry file
// explicitly; --import by name fails across the workspace boundary.
const hasTsx = existsSync(join(here, '..', 'node_modules', 'tsx', 'package.json'));
if (!hasTsx) {
  process.stderr.write('lionidas: tsx not installed — run pnpm install\n');
  process.exit(1);
}
const r = spawnSync(process.execPath, ['--import', 'tsx', entry, ...process.argv.slice(2)], { stdio: 'inherit', cwd: join(here, '..') });
process.exit(r.status ?? 1);
