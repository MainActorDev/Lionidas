import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Several suites mutate process.env (CRUCIBLE_AGENT_TOKEN, PATH, CRUCIBLE_APPS_DIR)
    // and spin real simulators — serialize files to keep them isolated.
    fileParallelism: false,
  },
});
