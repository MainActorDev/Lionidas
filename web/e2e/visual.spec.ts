import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { ROUTES, installMocks } from './routes';

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

      await expect(page).toHaveScreenshot(`${route.name}-${theme}`, { fullPage: true });

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
