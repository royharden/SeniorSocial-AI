import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { BASE_URL, locales, modes, preferenceCookies, viewports, type Locale, type Mode } from './route-matrix';

const eventId = '10000000-0000-4000-8000-000000000031';
const fixture = {
  items: [{
    id: eventId, title: 'Community lunch', starts_at: '2030-09-20T16:00:00.000Z',
    time_zone: 'America/New_York', location: 'Civic Hall', capacity: 20, rsvp_count: 4,
    accessibility: ['step-free'],
  }],
  reasons: { [eventId]: 'Matches step-free access' },
};

async function openEvents(page: Page, locale: Locale = 'en', mode: Mode = 'standard') {
  await page.context().addCookies(preferenceCookies(locale, mode));
  await page.route('**/api/v1/recommendations/events', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(fixture),
  }));
  const response = await page.goto(`${BASE_URL}/events`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Community lunch' })).toBeVisible();
  await expect(page.locator('form').filter({ has: page.locator('[name="time_zone"]') })).toBeVisible();
}

test.describe('events axe rows', () => {
  test.use({ bypassCSP: true, viewport: { width: 1280, height: 800 } });

  for (const locale of locales) {
    for (const mode of modes) {
      test(`/events is axe-clean [${locale}/${mode}]`, async ({ page }) => {
        await openEvents(page, locale, mode);
        const results = await new AxeBuilder({ page }).analyze();
        expect(results.violations.map(({ id, nodes }) => ({
          rule: id,
          targets: nodes.map(node => node.target.join(' ')),
        }))).toEqual([]);
      });
    }
  }
});

for (const locale of locales) {
  for (const viewport of viewports) {
    test(`/events Easy controls use 48px targets without clipping [${locale}/${viewport.name}]`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await openEvents(page, locale, 'easy');
      const evidence = await page.locator('main#main').evaluate(main => {
        const controls = [...main.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])',
        )];
        return {
          overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)
            - document.documentElement.clientWidth,
          controls: controls.map(control => {
            const rect = control.getBoundingClientRect();
            return {
              name: `${control.tagName.toLowerCase()}[name=${control.getAttribute('name') ?? '-'}]`,
              width: rect.width, height: rect.height, left: rect.left, right: rect.right,
            };
          }),
        };
      });
      expect(evidence.overflow).toBeLessThanOrEqual(1);
      expect(evidence.controls.length).toBeGreaterThanOrEqual(9);
      for (const control of evidence.controls) {
        expect.soft(control.width, `${control.name} width`).toBeGreaterThanOrEqual(48);
        expect.soft(control.height, `${control.name} height`).toBeGreaterThanOrEqual(48);
        expect.soft(control.left, `${control.name} clipped left`).toBeGreaterThanOrEqual(-1);
        expect.soft(control.right, `${control.name} clipped right`).toBeLessThanOrEqual(viewport.width + 1);
      }
    });
  }
}

test('listing and proposal controls follow DOM order with visible keyboard focus', async ({ page }) => {
  await openEvents(page);
  const selector = [
    'button[aria-label="Attend this event"]',
    'button[aria-label="Join the waitlist"]',
    'button[aria-label="Cancel attendance"]',
    'input[name="title"]',
    'input[name="starts_at"]',
    'select[name="time_zone"]',
    'textarea[name="note"]',
    'button[type="submit"]',
    'a[href="/help"]',
  ].join(',');
  const controls = page.locator('main#main').locator(selector);
  await expect(controls).toHaveCount(9);
  await controls.first().focus();
  for (let index = 0; index < 9; index += 1) {
    const expected = controls.nth(index);
    await expect.poll(async () => expected.evaluate(element => document.activeElement === element), {
      message: `keyboard did not reach events control ${index + 1}`,
    }).toBe(true);
    const state = await page.evaluate((expectedIndex) => {
      const active = document.activeElement as HTMLElement | null;
      const style = active ? getComputedStyle(active) : null;
      const rect = active?.getBoundingClientRect();
      const order = [...document.querySelectorAll<HTMLElement>('main#main button, main#main input, main#main select, main#main textarea, main#main a[href]')];
      return {
        index: active ? order.indexOf(active) : -1,
        expectedIndex,
        ring: Boolean(style && (style.outlineStyle !== 'none' || style.boxShadow !== 'none')),
        horizontal: Boolean(rect && rect.left >= -1 && rect.right <= document.documentElement.clientWidth + 1),
      };
    }, index);
    expect.soft(state.index, `tab stop ${index + 1}`).toBe(index);
    expect.soft(state.ring, `tab stop ${index + 1} focus indicator`).toBe(true);
    expect.soft(state.horizontal, `tab stop ${index + 1} horizontal visibility`).toBe(true);
    if (index < 8) {
      const next = controls.nth(index + 1);
      for (let press = 0; press < 8 && !await next.evaluate(element => document.activeElement === element); press += 1) {
        await page.keyboard.press('Tab');
      }
    }
  }
});

test('the live region precedes async work and repeated attendance failures are re-announced', async ({ page }) => {
  await page.addInitScript(() => {
    const records: string[] = [];
    const record = (node: Node) => {
      const element = node instanceof Element ? node : node.parentElement;
      const live = element?.closest('[role="status"][aria-live]');
      const text = live?.textContent?.replace(/\s+/gu, ' ').trim();
      if (text) records.push(text);
    };
    new MutationObserver(mutations => mutations.forEach(mutation => {
      record(mutation.target);
      mutation.addedNodes.forEach(record);
    })).observe(document, { subtree: true, childList: true, characterData: true });
    Object.defineProperty(window, '__eventAnnouncements', { value: records });
  });
  let resolveInitial = () => {};
  let initialReleased = false;
  const initialGate = new Promise<void>(resolve => { resolveInitial = resolve; });
  await page.route('**/api/v1/recommendations/events', async route => {
    if (!initialReleased) await initialGate;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture) });
  });
  const releases: Array<() => void> = [];
  await page.route(`**/api/v1/events/${eventId}/rsvp`, async route => {
    await new Promise<void>(resolve => releases.push(resolve));
    await route.fulfill({ status: 503, contentType: 'application/problem+json', body: '{}' });
  });
  await page.context().addCookies(preferenceCookies('en', 'standard'));
  await page.goto(`${BASE_URL}/events`, { waitUntil: 'domcontentloaded' });
  const status = page.locator('[data-events-page] > [role="status"]');
  await expect(status).toHaveCount(1);
  await expect(status).toContainText('Loading events');
  expect(await page.evaluate(() => (window as typeof window & { __eventAnnouncements: string[] }).__eventAnnouncements))
    .not.toContain('Your attendance choice could not be saved.');
  initialReleased = true;
  resolveInitial();
  await expect(page.getByRole('heading', { name: 'Community lunch' })).toBeVisible();
  await expect(status).toContainText('Machine recommendations are off. Browse the current event list instead.');

  let failureAnnouncements = 0;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await page.getByRole('button', { name: 'Attend this event' }).click();
    await expect(status).toContainText('Attend this event…');
    await expect.poll(() => releases.length).toBeGreaterThan(0);
    releases.shift()?.();
    await expect(status).toContainText('Your attendance choice could not be saved.');
    await expect.poll(async () => (await page.evaluate(() => (
      window as typeof window & { __eventAnnouncements: string[] }
    ).__eventAnnouncements)).filter(text => text === 'Your attendance choice could not be saved.').length)
      .toBeGreaterThan(failureAnnouncements);
    failureAnnouncements = (await page.evaluate(() => (
      window as typeof window & { __eventAnnouncements: string[] }
    ).__eventAnnouncements)).filter(text => text === 'Your attendance choice could not be saved.').length;
    expect(failureAnnouncements, `failure outcome ${attempt} was not announced`).toBeGreaterThan(0);
  }
});

test('load failure is announced after load progress without a construction-time false outcome', async ({ page }) => {
  let releaseLoad = () => {};
  const loadGate = new Promise<void>(resolve => { releaseLoad = resolve; });
  await page.route('**/api/v1/recommendations/events', async route => {
    await loadGate;
    await route.fulfill({ status: 503, contentType: 'application/problem+json', body: '{}' });
  });
  await page.context().addCookies(preferenceCookies('en', 'standard'));
  await page.goto(`${BASE_URL}/events`, { waitUntil: 'domcontentloaded' });
  const status = page.locator('[data-events-page] > [role="status"]');
  await expect(status).toContainText('Loading events…', { timeout: 15_000 });
  await expect(status).not.toContainText('Events could not be loaded. Try again.');
  releaseLoad();
  await expect(status).toContainText('Events could not be loaded. Try again.');
});

test('a stale Strict Mode load cannot overwrite the newer listing', async ({ page }) => {
  let releaseStale = () => {};
  const staleGate = new Promise<void>(resolve => { releaseStale = resolve; });
  let requestCount = 0;
  let staleFulfilled = false;
  await page.route('**/api/v1/recommendations/events', async route => {
    requestCount += 1;
    if (requestCount === 1) {
      await staleGate;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        ...fixture, items: [{ ...fixture.items[0], title: 'Stale community lunch' }],
      }) });
      staleFulfilled = true;
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      ...fixture, items: [{ ...fixture.items[0], title: 'Current community lunch' }],
    }) });
  });
  await page.context().addCookies(preferenceCookies('en', 'standard'));
  await page.goto(`${BASE_URL}/events`, { waitUntil: 'domcontentloaded' });
  await expect.poll(() => requestCount, { message: 'Strict Mode did not create the overlapping load' }).toBeGreaterThanOrEqual(2);
  await expect(page.getByRole('heading', { name: 'Current community lunch' })).toBeVisible();
  releaseStale();
  await expect.poll(() => staleFulfilled, { message: 'the stale response was not delivered' }).toBe(true);
  await expect(page.getByRole('heading', { name: 'Stale community lunch' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Current community lunch' })).toBeVisible();
});

test('proposal failures announce progress and repeat outcomes', async ({ page }) => {
  const releases: Array<() => void> = [];
  await page.route('**/api/v1/event-proposals', async route => {
    await new Promise<void>(resolve => releases.push(resolve));
    await route.fulfill({ status: 503, contentType: 'application/problem+json', body: '{}' });
  });
  await openEvents(page);
  await page.locator('[name="title"]').fill('Chess afternoon');
  await page.locator('[name="starts_at"]').fill('2030-09-21T18:00');
  await page.locator('[name="note"]').fill('Beginner tables welcome');
  const status = page.locator('[data-events-page] > [role="status"]');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.getByRole('button', { name: 'Send suggestion' }).click();
    await expect(status).toContainText('Send suggestion…');
    await expect.poll(() => releases.length).toBeGreaterThan(0);
    releases.shift()?.();
    await expect(status).toContainText('The event suggestion could not be saved.');
  }
});

test('RSVP, waitlist, cancel, and proposal requests retain their endpoints and payloads', async ({ page }) => {
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  await page.route('**/api/v1/events/**', async route => {
    requests.push({ url: new URL(route.request().url()).pathname, method: route.request().method(), body: route.request().postDataJSON() });
    await route.fulfill({ status: 201, contentType: 'application/json', body: '{}' });
  });
  await page.route('**/api/v1/event-proposals', async route => {
    requests.push({ url: new URL(route.request().url()).pathname, method: route.request().method(), body: route.request().postDataJSON() });
    await route.fulfill({ status: 201, contentType: 'application/json', body: '{}' });
  });
  await openEvents(page);
  await page.getByRole('button', { name: 'Attend this event' }).click();
  const status = page.locator('[data-events-page] > [role="status"]');
  await expect(status).toContainText('You are marked as attending.');
  await page.getByRole('button', { name: 'Join the waitlist' }).click();
  await expect(status).toContainText('On the waitlist');
  await page.getByRole('button', { name: 'Cancel attendance' }).click();
  await expect(status).toContainText('Your attendance was cancelled.');
  await page.locator('[name="title"]').fill('Chess afternoon');
  await page.locator('[name="starts_at"]').fill('2030-09-21T18:00');
  await page.locator('[name="note"]').fill('Beginner tables welcome');
  await page.getByRole('button', { name: 'Send suggestion' }).click();
  await expect(status).toContainText('Suggestion sent for staff review.');

  expect(requests.slice(0, 3)).toEqual([
    { url: `/api/v1/events/${eventId}/rsvp`, method: 'POST', body: null },
    { url: `/api/v1/events/${eventId}/waitlist`, method: 'POST', body: null },
    { url: `/api/v1/events/${eventId}/rsvp`, method: 'DELETE', body: null },
  ]);
  expect(requests[3]).toMatchObject({
    url: '/api/v1/event-proposals', method: 'POST',
    body: { title: 'Chess afternoon', time_zone: 'America/New_York', note: 'Beginner tables welcome' },
  });
  expect((requests[3]?.body as { starts_at?: string }).starts_at).toBe('2030-09-21T22:00:00.000Z');
});

test('server output contains the empty live region but no native proposal fields before hydration', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.context().addCookies(preferenceCookies('en', 'standard'));
  await page.goto(`${BASE_URL}/events`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('main#main [data-events-page] > [role="status"][aria-live="polite"]')).toHaveCount(1);
  await expect(page.locator('main#main input, main#main select, main#main textarea')).toHaveCount(0);
  await context.close();
});
