#!/usr/bin/env node
// crucible — CI entry point. Thin launcher: real logic in server/src/cli/index.ts.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, '..', 'server', 'src', 'cli', 'index.ts');

const r = spawnSync(process.execPath, ['--import', 'tsx', entry, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, CRUCIBLE_CLI: '1' },
});
process.exit(r.status ?? 2);
