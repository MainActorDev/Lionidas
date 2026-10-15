import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
const e2eDir = fileURLToPath(new URL('.', import.meta.url));

/** Visual + a11y e2e config (plan 20261015T082000Z).
 *  - Single browser (chromium) for determinism; local-first, no CI assumed.
 *  - locale/timezone pinned so toLocaleString output is machine-independent (review M1).
 *  - Baselines live in e2e/__screenshots__ and are committed; intentional
 *    changes update them via `pnpm --filter web test:e2e -- --update-snapshots`
 *    in a reviewed commit. */

export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.002,
      threshold: 0.2,
      animations: 'disabled',
      caret: 'hide',
    },
  },
  use: {
    baseURL: 'http://127.0.0.1:5277',
    locale: 'en-GB',
    timezoneId: 'UTC',
    colorScheme: 'dark',
    reducedMotion: 'reduce',
  },
  projects: [
    { name: 'desktop-1440', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile-375', use: { ...devices['Desktop Chrome'], viewport: { width: 375, height: 900 } } },
  ],
  webServer: {
    command: 'pnpm exec vite preview --port 5277 --strictPort',
    cwd: e2eDir.replace('/e2e/', '/'),
    port: 5277,
    reuseExistingServer: true,
    timeout: 60_000,
  },
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFileName}/{arg}-{projectName}-{platform}.png',
  reporter: [['list']],
});
