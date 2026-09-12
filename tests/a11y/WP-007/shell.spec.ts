import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const webUrl = process.env.WEB_URL ?? '';
const routes = ['/home', '/settings', '/help'] as const;

// Axe injects an evaluation script, so only this suite bypasses CSP. The normal
// smoke suite separately verifies nonce propagation and hydration under CSP.
test.use({ bypassCSP: true });

for (const route of routes) {
  for (const mode of ['standard', 'easy'] as const) {
    test(`shell ${route} is axe-clean in ${mode} mode @shell`, async ({ page }) => {
      await page.goto(`${webUrl}${route}`);
      if (mode === 'easy') {
        await page.context().addCookies([{ name: 'seniorsocial.display-mode.v1', value: 'easy', url: page.url() }]);
        await page.reload();
      }

      const results = await new AxeBuilder({ page }).analyze();
      expect(results.violations).toEqual([]);
    });
  }
}

test('Easy Mode action targets meet the 48px floor @shell', async ({ page }) => {
  await page.goto(`${webUrl}/home`);
  await page.context().addCookies([{ name: 'seniorsocial.display-mode.v1', value: 'easy', url: page.url() }]);
  await page.reload();
  await expect(page.locator('.ss-app')).toHaveAttribute('data-mode', 'easy');

  const undersizedTargets = await page.locator('.ss-app a, .ss-app button, .ss-app input').evaluateAll(
    (targets) => targets.filter((target) => target.getBoundingClientRect().height < 48).map((target) => target.outerHTML),
  );
  expect(undersizedTargets).toEqual([]);
});

test('the skip link is first and moves keyboard focus to the single main landmark @shell', async ({ page }) => {
  await page.goto(`${webUrl}/home`);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();
  await expect(page.getByRole('main')).toHaveCount(1);
});
