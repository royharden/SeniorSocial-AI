import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { BASE_URL, locales, modes, preferenceCookies } from './route-matrix';

const preferences = {
  mode: 'standard', locale: 'en', channels: {}, quiet_hours: {},
  no_outbound: true, shared_device: false,
};
const snapshot = {
  as_of: '2026-09-10T12:00:00.000Z', source_version: 'schedule:test:v1', items: [],
};

async function mockNotifySurfaces(page: Page) {
  await page.route('**/api/v1/me/preferences', async route => {
    const response = route.request().method() === 'PUT'
      ? route.request().postDataJSON() as Record<string, unknown>
      : preferences;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response) });
  });
  await page.route('**/api/v1/me/schedule/print', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(snapshot),
  }));
}

test.describe('WP-031 notification and print accessibility', () => {
  for (const locale of locales) {
    for (const mode of modes) {
      test(`keeps governed notify surfaces axe-clean [${locale}/${mode}]`, async ({ page }) => {
        await mockNotifySurfaces(page);
        await page.context().addCookies(preferenceCookies(locale, mode));
        for (const path of ['/settings/notifications', '/print']) {
          const response = await page.goto(`${BASE_URL}${path}`, { waitUntil: 'domcontentloaded' });
          expect(response?.status()).toBe(200);
          const surface = page.locator(path === '/print' ? '[data-print-schedule]' : '[data-notification-settings]');
          await expect(surface).not.toHaveAttribute('data-locale-pending', '');
          const results = await new AxeBuilder({ page }).include('main#main').analyze();
          expect(results.violations.map(({ id }) => id)).toEqual([]);
          await expect(page.locator('html')).toHaveAttribute('lang', locale);
          if (locale === 'es') {
            await expect(surface.locator('[data-render-state="provisional_english_fallback"]').first()).toHaveAttribute('lang', 'en');
            await expect(surface.locator('[data-catalog-affordance="provisional_english_fallback"]').first())
              .toHaveText('Spanish translation is awaiting review.');
            await expect(surface).not.toContainText('Configuración de notificaciones');
            await expect(surface).not.toContainText('Horario para imprimir');
          } else {
            await expect(surface.locator('[data-catalog-affordance]')).toHaveCount(0);
            await expect(surface.locator('[data-render-state="english_source"]').first()).toHaveAttribute('lang', 'en');
          }
        }
      });
    }
  }

  test('preserves checkbox payloads and exposes labels to keyboard and assistive technology', async ({ page }) => {
    const writes: Record<string, unknown>[] = [];
    await page.route('**/api/v1/me/preferences', async route => {
      if (route.request().method() === 'PUT') writes.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(writes.at(-1) ?? preferences) });
    });
    await page.context().addCookies(preferenceCookies('en', 'easy'));
    await page.goto(`${BASE_URL}/settings/notifications`, { waitUntil: 'domcontentloaded' });
    const surface = page.locator('[data-notification-settings]');
    await expect(surface).not.toHaveAttribute('data-locale-pending', '');
    const shared = page.getByRole('checkbox', { name: 'I share this phone or device' });
    await shared.focus();
    await expect(shared).toBeFocused();
    await page.keyboard.press('Space');
    await page.getByRole('button', { name: 'Save notification settings' }).click();
    await expect(surface.getByRole('status')).toContainText('Notification settings saved.');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ shared_device: true, no_outbound: true, channels: {} });
  });
});
