import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { ROUTES, installMocks, ANCHOR } from './routes';

/** Visual regression + accessibility gate (plan 20261015T082000Z).
 *  Iterates the route table × projects (viewports) × themes (dark active,
 *  light via class flip). Runner-specific code lives ONLY here — when the
 *  Lionidas web engine takes over e2e, this file is rewritten and
 *  routes.ts + baselines survive. */

const THEMES = ['dark', 'light'] as const;

for (const route of ROUTES) {
  for (const theme of THEMES) {
    test(`visual + a11y — ${route.name} [${theme}]`, async ({ page }) => {
      await installMocks(page);
      // Freeze relative time: pages render "Xh ago" from Date.now(); real
      // clock drift would rot baselines within hours (fixture anchors to
      // 2026-10-15T09:00Z — ANCHOR in routes.ts).
      // setFixedTime (not pauseAt): deterministic Date.now() without freezing
      // timers — pauseAt hangs axe-core's polling (60s timeouts).
      await page.clock.install();
      await page.clock.setFixedTime(ANCHOR);
      if (theme === 'light') {
        await page.addInitScript(() => document.documentElement.classList.remove('dark'));
      }
      await page.goto(route.path, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector(route.readySelector, { timeout: 15_000 });
      // H1 pass criterion: we are ON the route, not bounced to /login
      expect(page.url()).not.toContain('/login');
      expect(page.url()).toContain(route.path === '/' ? new URL(page.url()).pathname : route.path);
      // fonts settle before capture (Geist via Google Fonts)
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(250);

      await expect(page).toHaveScreenshot(`${route.name}-${theme}`, {
        fullPage: true,
        maxDiffPixelRatio: 0.0005,
        threshold: 0.05,
        animations: 'disabled',
        caret: 'hide',
      });

      // STRUCTURAL gate — catches layout breaks that photos hide under pixel
      // budgets (lesson: shrink-wrapped rows once landed 0.19% under a 0.2%
      // threshold). Every ledger row must span the same width as its day
      // header, and the page must not overflow horizontally.
      const layout = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.row')].map((r) => Math.round(r.getBoundingClientRect().width));
        const day = document.querySelector('.day');
        const uniform = rows.length === 0 || (day && rows.every((w) => Math.abs(w - rows[0]) < 2));
        return { rows: rows.length, uniform, overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 };
      });
      expect(layout.overflowX).toBe(false);
      if (page.url().includes('/audit')) expect(layout.uniform).toBe(true);

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa'])
        .analyze();
      expect(results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);
    });
  }
}

/** open-state surface: audit detail Sheet (known a11y-sensitive) */
test('visual + a11y — audit detail sheet open [dark]', async ({ page }) => {
  await installMocks(page);
  await page.goto('/audit', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.row', { timeout: 15_000 });
  expect(page.url()).not.toContain('/login');
  await page.locator('.row').first().click();
  await page.waitForSelector('[data-slot="sheet-content"]', { timeout: 5_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);

  await expect(page).toHaveScreenshot('audit-sheet-dark', { fullPage: false });

  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);
});
