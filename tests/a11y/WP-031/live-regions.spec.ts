import { expect, test, type Page } from '@playwright/test';
import { BASE_URL, preferenceCookies } from './route-matrix';

type Announcement = { role: string; text: string };

async function installAnnouncementRecorder(page: Page) {
  await page.addInitScript(() => {
    const records: Array<{ role: string; text: string }> = [];
    const liveContainer = (node: Node) => {
      const element = node instanceof Element ? node : node.parentElement;
      return element?.closest('[role="status"], [role="alert"], [aria-live]');
    };
    const record = (node: Node) => {
      const live = liveContainer(node);
      const text = live?.textContent?.replace(/\s+/g, ' ').trim();
      if (live && text) records.push({ role: live.getAttribute('role') ?? `live:${live.getAttribute('aria-live')}`, text });
    };
    new MutationObserver(mutations => mutations.forEach(mutation => {
      record(mutation.target);
      mutation.addedNodes.forEach(record);
    }))
      .observe(document, { subtree: true, childList: true, characterData: true });
    Object.defineProperty(window, '__wp031Announcements', { value: records });
  });
}

async function announcements(page: Page): Promise<Announcement[]> {
  return page.evaluate(() => (window as typeof window & { __wp031Announcements?: Announcement[] }).__wp031Announcements ?? []);
}

async function resetAnnouncements(page: Page) {
  await page.evaluate(() => {
    const records = (window as typeof window & { __wp031Announcements?: Announcement[] }).__wp031Announcements;
    if (records) records.length = 0;
  });
}

async function waitForHydratedControl(page: Page, selector: string) {
  await expect(page.locator(selector)).toBeEnabled({ timeout: 15_000 });
}

async function open(page: Page, path: string) {
  await page.context().addCookies(preferenceCookies('en', 'standard'));
  await installAnnouncementRecorder(page);
  await page.goto(new URL(path, BASE_URL).toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await expect(page.locator('body')).toBeVisible();
}

const loadingResults = [
  { path: '/events', endpoint: '**/api/v1/recommendations/events' },
  { path: '/settings/notifications', endpoint: '**/api/v1/me/preferences' },
  { path: '/print', endpoint: '**/api/v1/me/schedule/print' },
] as const;

for (const { path, endpoint } of loadingResults) {
  test(`${path} loading result is exposed as a live announcement`, async ({ page }) => {
    let releaseResponse = () => {};
    const responseGate = new Promise<void>(resolve => { releaseResponse = resolve; });
    await page.route(endpoint, async route => {
      await responseGate;
      await route.fulfill({ status: 401, contentType: 'application/json', body: '{}' });
    });
    await open(page, path);
    await resetAnnouncements(page);
    releaseResponse();
    await expect.poll(async () => announcements(page), { timeout: 5_000 }).not.toEqual([]);
    expect(await announcements(page)).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'status' })]));
  });
}

test('/rides announces the result of a submission attempt', async ({ page }) => {
  await open(page, '/rides');
  await waitForHydratedControl(page, '[data-ride-request-form] button[type="submit"]');
  await expect(page.getByRole('button', { name: 'Send ride request' })).toBeEnabled();
  await resetAnnouncements(page);
  await page.locator('input[name="pickup_at"]').fill('2030-01-02T10:30');
  await page.getByRole('button', { name: 'Send ride request' }).click();
  await expect(page.locator('form.ss-card').getByRole('status')).not.toHaveText('No request has been sent.');
  expect(await announcements(page)).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'status' })]));
});

test('/caregiver announces the result of an invitation attempt', async ({ page }) => {
  await page.route('**/api/v1/caregiver/invitations', route => route.fulfill({
    status: 503, contentType: 'application/problem+json', body: '{"detail":"synthetic_unavailable"}',
  }));
  await open(page, '/caregiver');
  await waitForHydratedControl(page, '#caregiver-recipient');
  await resetAnnouncements(page);
  await page.locator('#caregiver-recipient').fill('audit@example.test');
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.locator('.ss-content').getByRole('status')).not.toBeEmpty();
  expect(await announcements(page)).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'status' })]));
});

test('/help exposes its assistance result as a live announcement', async ({ page }) => {
  await page.route('**/api/v1/assistance-requests', route => route.fulfill({
    status: 503, contentType: 'application/problem+json', body: '{"detail":"synthetic_unavailable"}',
  }));
  await open(page, '/help');
  await waitForHydratedControl(page, '[data-assistance-form] button[type="submit"]');
  await resetAnnouncements(page);
  await page.locator('#assistance-summary').fill('Accessibility audit synthetic request');
  await page.locator('[data-assistance-form] button[type="submit"]').click();
  await expect(page.locator('form').getByRole('alert').or(page.getByRole('heading', { name: 'Request saved' }))).toBeVisible();
  expect(await announcements(page), 'the assistance result changed without a live announcement').not.toEqual([]);
});

test('/concierge exposes the start result as a live announcement', async ({ page }) => {
  await open(page, '/concierge');
  await expect(page.getByRole('button', { name: 'Get help finding a service' })).toBeEnabled();
  await resetAnnouncements(page);
  expect(await page.locator('main#main [role="status"], main#main [role="alert"], main#main [aria-live]').count(),
    'the result needs a live container before the asynchronous update').toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Get help finding a service' }).click();
  const announcedError = page.locator('main#main [role="alert"]').filter({ hasText: /\S/u });
  await expect(announcedError.or(page.getByRole('link', { name: 'Browse services' }))).toBeVisible();
  expect(await announcements(page), 'the concierge start result changed without a live announcement').not.toEqual([]);
});
