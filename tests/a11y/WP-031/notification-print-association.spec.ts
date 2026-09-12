import { expect, test, type Locator, type Page } from '@playwright/test';

const preferences = {
  mode: 'standard', locale: 'en', channels: {}, quiet_hours: {},
  no_outbound: true, shared_device: false,
};
const snapshot = {
  as_of: '2026-09-10T12:00:00.000Z', source_version: 'schedule:test:v1', items: [],
};

async function useSpanish(page: Page, baseURL: string | undefined) {
  if (baseURL === undefined) throw new Error('Playwright baseURL is required');
  await page.context().addCookies([
    { name: 'seniorsocial.locale.v1', value: 'es', url: new URL(baseURL).origin },
  ]);
}

async function expectExactAssociations(surface: Locator) {
  const notices = surface.locator('[data-catalog-affordance-group] [role="note"]');
  await expect(notices).toHaveCount(1);
  const notice = notices.first();
  await expect(notice).toHaveText('Spanish translation is awaiting review.');
  await expect(notice).toHaveAttribute('data-catalog-affordance', 'provisional_english_fallback');
  await expect(notice).toHaveAttribute('data-catalog-fallback-reason', 'provisional_translation');
  const noticeId = await notice.getAttribute('id');
  expect(noticeId).toBeTruthy();

  const noticeIds = await notices.evaluateAll(elements => elements.map(element => element.id));
  expect(new Set(noticeIds).size).toBe(noticeIds.length);

  const fallbackText = surface.locator('[data-catalog-key][data-render-state="provisional_english_fallback"]');
  expect(await fallbackText.count()).toBeGreaterThan(1);
  for (const element of await fallbackText.all()) {
    await expect(element).toHaveAttribute('aria-describedby', noticeId!);
    await expect(element).toHaveAttribute('data-catalog-render-state', 'provisional_english_fallback');
    await expect(element).toHaveAttribute('data-catalog-fallback-reason', 'provisional_translation');
    await expect(element).toHaveAttribute('data-catalog-review-status', /^(draft|awaiting_review)$/);
    await expect(element).toHaveAttribute('data-catalog-key', /^notify\./);
  }

  const referencedKeys = (await notice.getAttribute('data-catalog-keys'))?.split(' ') ?? [];
  expect(new Set(referencedKeys).size).toBe(referencedKeys.length);
  for (const key of await fallbackText.evaluateAll(elements => elements.map(element => element.getAttribute('data-catalog-key')))) {
    expect(referencedKeys).toContain(key);
  }
  await expect(surface.locator('label [role="note"], button [role="note"], a [role="note"]')).toHaveCount(0);

  const describedByReferences = await surface.locator('[aria-describedby]').evaluateAll(elements =>
    elements.flatMap(element => (element.getAttribute('aria-describedby') ?? '').split(/\s+/u).filter(Boolean)),
  );
  expect(describedByReferences.length).toBeGreaterThan(1);
  expect(new Set(describedByReferences)).toEqual(new Set(noticeIds));
  for (const reference of describedByReferences) {
    await expect(surface.locator(`[id="${reference}"]`)).toHaveCount(1);
  }

  return noticeId!;
}

test.describe('WP-031 notification and print fallback associations', () => {
  test('deduplicates notification notices outside controls while preserving preference behavior', async ({ page, baseURL }) => {
    const writes: Record<string, unknown>[] = [];
    await page.route('**/api/v1/me/preferences', async route => {
      if (route.request().method() === 'PUT') writes.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(writes.at(-1) ?? preferences) });
    });
    await useSpanish(page, baseURL);
    await page.goto('/settings/notifications', { waitUntil: 'domcontentloaded' });
    const surface = page.locator('[data-notification-settings]');
    await expect(surface).not.toHaveAttribute('data-locale-pending', '');
    const initialNoticeId = await expectExactAssociations(surface);

    const shared = page.getByRole('checkbox', { name: 'I share this phone or device' });
    const governedControls = surface.locator('form input, form button, a[href="/print"]');
    expect(await governedControls.count()).toBeGreaterThan(1);
    for (const control of await governedControls.all()) {
      await expect(control).toHaveAttribute('aria-describedby', initialNoticeId);
    }
    await shared.check();
    await page.getByRole('button', { name: 'Save notification settings' }).click();
    await expect(surface.getByRole('status')).toContainText('Notification settings saved.');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual({ ...preferences, shared_device: true });
    expect(await expectExactAssociations(surface)).toBe(initialNoticeId);
  });

  test('deduplicates printable schedule notices without changing snapshot output or action', async ({ page, baseURL }) => {
    await page.route('**/api/v1/me/schedule/print', route => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(snapshot),
    }));
    await useSpanish(page, baseURL);
    await page.goto('/print', { waitUntil: 'domcontentloaded' });
    const surface = page.locator('[data-print-schedule]');
    await expect(surface).not.toHaveAttribute('data-locale-pending', '');
    const noticeId = await expectExactAssociations(surface);
    await expect(surface).toContainText(snapshot.source_version);
    await expect(surface).toContainText(snapshot.as_of);
    await expect(surface).toContainText('No items are recorded in this source snapshot.');
    const action = surface.getByRole('link', { name: 'Open a freshly authorized print view' });
    await expect(action).toHaveAttribute('href', '/api/v1/me/schedule/print');
    await expect(action).toHaveAttribute('target', '_blank');
    await expect(action).toHaveAttribute('rel', 'noopener');
    await expect(action).toHaveAttribute('aria-describedby', noticeId);
  });

  test('renders English without fallback notices or fallback descriptions', async ({ page }) => {
    await page.route('**/api/v1/me/preferences', route => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(preferences),
    }));
    await page.route('**/api/v1/me/schedule/print', route => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(snapshot),
    }));
    for (const path of ['/settings/notifications', '/print']) {
      await page.goto(path, { waitUntil: 'domcontentloaded' });
      const surface = page.locator(path === '/print' ? '[data-print-schedule]' : '[data-notification-settings]');
      await expect(surface).not.toHaveAttribute('data-locale-pending', '');
      await expect(surface.locator('[data-catalog-affordance-group], [data-catalog-affordance]')).toHaveCount(0);
      await expect(surface.locator('[aria-describedby]')).toHaveCount(0);
      await expect(surface.locator('[data-render-state="english_source"]').first()).toHaveAttribute('lang', 'en');
    }
  });
});
