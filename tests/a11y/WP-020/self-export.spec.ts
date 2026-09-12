import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const locales = ['en', 'es'] as const;
const modes = ['standard', 'easy'] as const;
const viewports = [{ name: 'desktop', width: 1280, height: 800 }, { name: 'mobile', width: 360, height: 640 }] as const;

async function openExport(page: Page, locale: typeof locales[number], mode: typeof modes[number]) {
  await page.context().addCookies([
    { name: 'seniorsocial.locale.v1', value: locale, url: 'http://localhost:3110' },
    { name: 'seniorsocial.display-mode.v1', value: mode, url: 'http://localhost:3110' },
  ]);
  await page.goto('http://localhost:3110/settings/data-export', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-data-export]')).toBeVisible();
  await expect(page.locator('[data-data-export] button[type="submit"]')).toBeEnabled({ timeout: 10_000 });
}

for (const locale of locales) {
  for (const mode of modes) {
    for (const viewport of viewports) {
      test(`self export is axe-clean [${locale}/${mode}/${viewport.name}]`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await openExport(page, locale, mode);
        const results = await new AxeBuilder({ page }).analyze();
        expect(results.violations.map(({ id, nodes }) => ({ id, targets: nodes.map(node => node.target.join(' ')) }))).toEqual([]);
      });
    }
  }
}

for (const locale of locales) {
  for (const viewport of viewports) {
    test(`Easy self-export controls are 48px and unclipped [${locale}/${viewport.name}]`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await openExport(page, locale, 'easy');
      const evidence = await page.locator('[data-data-export]').evaluate(root => ({
        overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - document.documentElement.clientWidth,
        controls: [...root.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled])')].map(control => {
          const rect = control.getBoundingClientRect();
          return { name: control.outerHTML.slice(0, 80), width: rect.width, height: rect.height, left: rect.left, right: rect.right };
        }),
      }));
      expect(evidence.overflow).toBeLessThanOrEqual(1);
      expect(evidence.controls.length).toBeGreaterThanOrEqual(9);
      for (const control of evidence.controls) {
        expect.soft(control.width, `${control.name} width`).toBeGreaterThanOrEqual(48);
        expect.soft(control.height, `${control.name} height`).toBeGreaterThanOrEqual(48);
        expect.soft(control.left, `${control.name} left`).toBeGreaterThanOrEqual(-1);
        expect.soft(control.right, `${control.name} right`).toBeLessThanOrEqual(viewport.width + 1);
      }
    });
  }
}

test('keyboard order is stable and focus is visible', async ({ page }) => {
  await openExport(page, 'en', 'standard');
  const controls = page.locator('[data-data-export] input[type="checkbox"], [data-data-export] input[type="radio"]:checked, [data-data-export] button, [data-data-export] a[href]');
  await expect(controls).toHaveCount(8);
  await controls.first().focus();
  for (let index = 0; index < 8; index += 1) {
    await expect(controls.nth(index)).toBeFocused();
    const ring = await controls.nth(index).evaluate(element => {
      const style = getComputedStyle(element);
      return style.outlineStyle !== 'none' || style.boxShadow !== 'none';
    });
    expect.soft(ring, `control ${index + 1} has no visible focus indicator`).toBe(true);
    if (index < 7) await page.keyboard.press('Tab');
  }
  await page.getByLabel('JSON').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByLabel('CSV (ZIP archive)')).toBeFocused();
});

test('pending and repeated failure updates are announced from the existing live region', async ({ page }) => {
  await page.addInitScript(() => {
    const announcements: string[] = [];
    new MutationObserver(records => records.forEach(record => {
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      const live = target?.closest('[role="status"][aria-live]');
      const text = live?.textContent?.trim();
      if (text) announcements.push(text);
    })).observe(document, { subtree: true, childList: true, characterData: true });
    Object.defineProperty(window, '__exportAnnouncements', { value: announcements });
  });
  const releases: Array<() => void> = [];
  let responseCount = 0;
  await page.route('**/api/v1/admin/exports', async route => {
    await new Promise<void>(resolve => releases.push(resolve));
    responseCount += 1;
    await route.fulfill(responseCount < 3
      ? { status: 503, contentType: 'application/problem+json', body: '{}' }
      : { status: 202, contentType: 'application/json', body: JSON.stringify({
        id: '33333333-3333-4333-8333-333333333333', state: 'ready', scope: ['profile'],
        completeness_note: 'complete', download_url: '/api/v1/admin/exports/33333333-3333-4333-8333-333333333333/download',
        expires_at: '2030-09-12T16:30:00.000Z',
      }) });
  });
  await openExport(page, 'en', 'standard');
  const status = page.locator('[data-export-status]');
  const button = page.getByRole('button', { name: 'Create data export' });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await button.click();
    await expect(status).toHaveText(attempt === 0
      ? 'Your export request is pending.'
      : 'Retrying the exact request with the same replay key.');
    await expect.poll(() => releases.length).toBeGreaterThan(0);
    releases.shift()?.();
    await expect(status).toHaveText('The export could not be created. You can try the same request again.');
  }
  await button.click();
  await expect(status).toHaveText('Retrying the exact request with the same replay key.');
  await expect.poll(() => releases.length).toBeGreaterThan(0);
  releases.shift()?.();
  await expect(status).toHaveText('Your export is ready.');
  const announcements = await page.evaluate(() => (window as typeof window & { __exportAnnouncements: string[] }).__exportAnnouncements);
  expect(announcements.filter(value => value === 'The export could not be created. You can try the same request again.').length).toBeGreaterThanOrEqual(2);
  expect(announcements).toContain('Retrying the exact request with the same replay key.');
  expect(announcements).toContain('Your export is ready.');
});
