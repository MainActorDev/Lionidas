import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Suites spawn real subprocesses (networksetup fakes, plutil, stat) and boot
    // fastify apps per test; the 5s default only holds on an idle machine.
    // Env-mutating suites are safe under file-parallelism: vitest 3 forks one
    // process per file, so process.env changes never cross files.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
