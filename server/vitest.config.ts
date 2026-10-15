import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Suites spawn real subprocesses (networksetup fakes, plutil, stat) and boot
    // fastify apps per test; the 5s default only holds on an idle machine.
    // Env-mutating suites are safe under file-parallelism: vitest 3 forks one
    // process per file, so process.env changes never cross files.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // CI (macos runners) died with ERR_IPC_CHANNEL_CLOSED: 124 forked workers
    // spawning at once under the runner's constrained CPU kill tinypool's IPC.
    // A bounded pool (4) fixes the channel storm with no measurable local cost
    // (971/971 in the same wall time on a 10-core dev box).
    // 2026-10-15: also cap LOCAL runs — unbounded forks spiked RAM on the dev
    // box. Override per-run with `vitest run --maxWorkers=<n>` when needed.
    maxWorkers: 4,
    // repos/ holds CLONES of registered projects (incl. Lionidas itself via the
    // self-project drill) — their stale test copies must never shadow our suite
    exclude: ['**/node_modules/**', '**/repos/**', '**/.wt/**'],
  },
});
