import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { locales, modes, preferenceCookies, routes } from './route-matrix';

// This is the only WP-031 file allowed to bypass CSP. Axe injects its analyzer;
// keyboard, layout, announcement, and infrastructure tests run with real CSP.
test.use({ bypassCSP: true, viewport: { width: 1280, height: 800 } });

for (const locale of locales) {
  for (const mode of modes) {
    test(`all routes are axe-clean [${locale}/${mode}]`, async ({ context, page }) => {
      await context.addCookies(preferenceCookies(locale, mode));
      for (const route of routes) {
        const response = await page.goto(route.path, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        const status = response?.status() ?? 0;
        expect.soft(status, `shared app infrastructure did not render ${route.path}`).toBeGreaterThanOrEqual(200);
        expect.soft(status, `shared app infrastructure did not render ${route.path}`).toBeLessThan(400);
        // Do not scan a framework error/not-found document and misclassify its
        // violations as defects in the requested product route.
        if (status < 200 || status >= 400) continue;
        await expect(page.locator('body')).toBeVisible();
        // Client-rendered routes must reach their user-observable page heading
        // before axe scans the settled product tree.
        await expect(page.locator('main#main h1')).toHaveCount(1, { timeout: 15_000 });
        const results = await new AxeBuilder({ page }).analyze();
        const evidence = results.violations.map(({ id, impact, nodes }) => ({
          rule: id,
          impact,
          nodes: nodes.map(node => ({ selector: node.target.join(' '), summary: node.failureSummary })),
        }));
        expect.soft(evidence, `axe product defects for ${route.path} [${locale}/${mode}]`).toEqual([]);
      }
    });
  }
}
