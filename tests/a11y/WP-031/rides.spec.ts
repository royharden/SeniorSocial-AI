import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { BASE_URL, locales, modes, preferenceCookies, viewports } from './route-matrix';

const formControls = 'select, input, button';
const formCatalogKeys = [
  'rides.accessibility.door_to_door',
  'rides.accessibility.legend',
  'rides.accessibility.needs_an_arm',
  'rides.accessibility.oxygen',
  'rides.accessibility.service_animal',
  'rides.accessibility.walker',
  'rides.accessibility.wheelchair',
  'rides.destination.community',
  'rides.destination.grocery',
  'rides.destination.label',
  'rides.destination.medical',
  'rides.destination.other',
  'rides.mode.label',
  'rides.mode.paratransit',
  'rides.mode.partner_van',
  'rides.mode.rideshare',
  'rides.mode.taxi_voucher',
  'rides.pickup.home',
  'rides.pickup.other',
  'rides.pickup.place',
  'rides.pickup.time',
  'rides.purpose.community',
  'rides.purpose.grocery',
  'rides.purpose.label',
  'rides.purpose.medical',
  'rides.request.none',
  'rides.request.send',
  'rides.return.label',
] as const;

async function openRide(page: Page, locale: 'en' | 'es' = 'en', mode: 'standard' | 'easy' = 'standard') {
  await page.context().addCookies(preferenceCookies(locale, mode));
  const response = await page.goto(`${BASE_URL}/rides`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  expect(response?.status()).toBe(200);
  await expect(page.locator('[data-ride-request-form]')).toBeVisible();
  await expect(page.locator('[data-ride-request-form] button[type="submit"]')).toBeEnabled({ timeout: 15_000 });
}

async function installAnnouncementRecorder(page: Page) {
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
    Object.defineProperty(window, '__rideAnnouncements', { value: records });
  });
}

async function announcementTexts(page: Page) {
  return page.evaluate(() => (window as typeof window & { __rideAnnouncements?: string[] }).__rideAnnouncements ?? []);
}

test.describe('WP-031 /rides focused accessibility contract', () => {
  test.use({ bypassCSP: true });

  for (const locale of locales) {
    for (const mode of modes) {
      test(`is axe-clean and catalog-safe [${locale}/${mode}]`, async ({ page }) => {
        await openRide(page, locale, mode);
        const results = await new AxeBuilder({ page }).include('main#main').analyze();
        expect(results.violations.map(({ id }) => id)).toEqual([]);
        await expect(page.locator('html')).toHaveAttribute('lang', locale);
        await expect(page.getByRole('heading', { name: 'Ride request' })).toBeVisible();
        await expect(page.getByText('Submitting a request does not book or confirm a ride.')).toBeVisible();
        const catalogValues = page.locator('[data-ride-request-form] [data-catalog-render-state]');
        const formAffordances = page.locator('[data-ride-request-form] [data-catalog-affordance]');
        await expect(catalogValues).toHaveCount(formCatalogKeys.length);
        expect((await catalogValues.evaluateAll(elements => elements.map(element =>
          element.getAttribute('data-catalog-key')).sort()))).toEqual(formCatalogKeys);
        if (locale === 'en') {
          await expect(formAffordances).toHaveCount(0);
        } else {
          await expect(formAffordances).toHaveCount(formCatalogKeys.length);
          expect((await formAffordances.evaluateAll(elements => elements.map(element =>
            element.getAttribute('data-catalog-key')).sort()))).toEqual(formCatalogKeys);
        }
        const affordanceErrors = await formAffordances.evaluateAll(elements => elements.flatMap(element => {
          const catalogKey = element.getAttribute('data-catalog-key');
          const renderState = element.getAttribute('data-catalog-affordance');
          if (!catalogKey || !renderState) return ['fallback notice lacks its ride key or state'];
          if (element.matches('option')) {
            return element.textContent?.includes(' — ') ? [] : [`${catalogKey} option does not include its notice`];
          }
          const previous = element.previousElementSibling;
          return previous?.getAttribute('data-catalog-key') === catalogKey
            && previous.getAttribute('data-catalog-render-state') === renderState
            ? []
            : [`${catalogKey} notice is not adjacent to its resolved value`];
        }));
        expect(affordanceErrors).toEqual([]);
        if (locale === 'es') {
          await expect(page.locator('p[data-catalog-affordance="provisional_english_fallback"]'))
            .toHaveText('Spanish translation is awaiting review.');
          await expect(page.getByRole('heading', { name: 'Ride request' }).locator('span')).toHaveAttribute('lang', 'en');
        }
      });
    }
  }

  for (const viewport of viewports) {
    test(`Easy Mode controls are 48px and the form does not clip [${viewport.name}]`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await openRide(page, 'en', 'easy');
      const undersized = await page.locator('[data-ride-request-form]').locator(formControls).evaluateAll(elements =>
        elements.flatMap(element => {
          const control = element as HTMLElement;
          const measured = control.matches('input[type="checkbox"]') ? control.closest('label') ?? control : control;
          const rect = measured.getBoundingClientRect();
          return rect.width < 48 || rect.height < 48
            ? [`${control.tagName.toLowerCase()}[name=${control.getAttribute('name') ?? '-'}] ${rect.width}x${rect.height}`]
            : [];
        }));
      expect(undersized).toEqual([]);
      const geometry = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      }));
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
    });
  }

  test('keyboard order reaches every form control with visible focus', async ({ page }) => {
    await openRide(page, 'en', 'easy');
    const form = page.locator('[data-ride-request-form]');
    const expected = await form.locator(formControls).count();
    await page.locator('main#main').focus();
    const seen: string[] = [];
    for (let press = 0; press < expected + 12 && seen.length < expected; press += 1) {
      await page.keyboard.press('Tab');
      const state = await page.evaluate(() => {
        const active = document.activeElement as HTMLElement | null;
        if (!active?.closest('[data-ride-request-form]')) return null;
        const style = getComputedStyle(active);
        return {
          id: active.id || `${active.tagName.toLowerCase()}:${active.getAttribute('name') ?? '-'}:${active.getAttribute('value') ?? '-'}`,
          ring: style.outlineStyle !== 'none' || style.boxShadow !== 'none',
        };
      });
      if (state && !seen.includes(state.id)) {
        expect(state.ring, `missing visible focus on ${state.id}`).toBe(true);
        seen.push(state.id);
      }
    }
    expect(seen).toEqual([
      'ride-purpose', 'ride-mode', 'ride-pickup-at', 'ride-pickup-place', 'ride-destination',
      'input:accessibility:wheelchair', 'input:accessibility:walker', 'input:accessibility:needs_an_arm',
      'input:accessibility:service_animal', 'input:accessibility:oxygen', 'input:accessibility:door_to_door',
      'input:return_needed:-', 'button:-:-',
    ]);
  });

  test('one pre-existing live region starts empty and announces repeated saves, success, and failure', async ({ page }) => {
    await installAnnouncementRecorder(page);
    let attempt = 0;
    let releaseSuccess = () => {};
    const successGate = new Promise<void>(resolve => { releaseSuccess = resolve; });
    await page.route('**/api/v1/rides', async route => {
      attempt += 1;
      if (attempt === 1) {
        await successGate;
        await route.fulfill({ status: 201, contentType: 'application/json', body: '{"state":"waiting_for_dispatcher","send_state":"sent"}' });
      } else {
        await route.fulfill({ status: 503, contentType: 'application/problem+json', body: '{}' });
      }
    });
    await openRide(page);
    const status = page.locator('[data-ride-request-form]').getByRole('status');
    await expect(page.locator('[data-ride-initial-state]')).toHaveText('No ride request has been saved yet.');
    await expect(status).toBeEmpty();
    expect(await announcementTexts(page)).toEqual([]);
    await page.locator('#ride-pickup-at').fill('2030-01-02T10:30');
    await page.getByRole('button', { name: 'Send ride request' }).click();
    await expect(status).toHaveText('Saving ride request…');
    releaseSuccess();
    await expect(status).toHaveText('The request was sent, but the ride is not confirmed.');
    await page.getByRole('button', { name: 'Send ride request' }).click();
    await expect(status).toHaveText('The ride request could not be sent.');

    const allowed = new Set([
      'Saving ride request…',
      'The request was sent, but the ride is not confirmed.',
      'The ride request could not be sent.',
    ]);
    const records = await announcementTexts(page);
    expect(records.length).toBeGreaterThanOrEqual(3);
    expect(records.every(text => allowed.has(text))).toBe(true);
    for (const expected of allowed) expect(records).toContain(expected);
    expect(records.filter(text => text === 'Saving ride request…').length).toBeGreaterThanOrEqual(2);
  });

  test('keeps the API URL, idempotency header, codes, and payload fields stable across retry', async ({ page }) => {
    const requests: Array<{ headers: Record<string, string>; payload: Record<string, unknown>; url: string }> = [];
    await page.route('**/api/v1/rides', async route => {
      requests.push({
        headers: route.request().headers(),
        payload: route.request().postDataJSON() as Record<string, unknown>,
        url: route.request().url(),
      });
      await route.fulfill(requests.length === 1
        ? { status: 503, contentType: 'application/problem+json', body: '{}' }
        : { status: 201, contentType: 'application/json', body: '{"state":"waiting_for_dispatcher","send_state":"sent"}' });
    });
    await openRide(page);
    await page.locator('#ride-pickup-at').fill('2030-01-02T10:30');
    await page.locator('input[name="accessibility"][value="wheelchair"]').check();
    await page.locator('input[name="return_needed"]').check();
    const submit = page.getByRole('button', { name: 'Send ride request' });
    await submit.click();
    const status = page.locator('[data-ride-request-form]').getByRole('status');
    await expect(status).toHaveText('The ride request could not be sent.');
    await submit.click();
    await expect(status).toContainText('not confirmed');

    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toMatch(/\/api\/v1\/rides$/u);
    expect(requests[0]?.headers['content-type']).toBe('application/json');
    expect(requests[0]?.headers['idempotency-key']).toBeTruthy();
    expect(requests[1]?.headers['idempotency-key']).toBe(requests[0]?.headers['idempotency-key']);
    expect(Object.keys(requests[0]?.payload ?? {}).sort()).toEqual([
      'accessibility_details', 'destination_location', 'mode', 'pickup_at', 'pickup_location',
      'pickup_tz', 'purpose', 'return_needed',
    ]);
    expect(requests[0]?.payload).toMatchObject({
      accessibility_details: [{ code: 'wheelchair', label: 'Wheelchair' }],
      destination_location: 'clinic', mode: 'partner_van', pickup_location: 'home',
      purpose: 'medical', return_needed: true,
    });
  });

  test('does not start an overlapping request that could later overwrite the current result', async ({ page }) => {
    let requests = 0;
    let release = () => {};
    const responseGate = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/v1/rides', async route => {
      requests += 1;
      await responseGate;
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: '{"state":"waiting_for_dispatcher","send_state":"sent"}',
      });
    });
    await openRide(page);
    await page.locator('#ride-pickup-at').fill('2030-01-02T10:30');
    const form = page.locator('[data-ride-request-form]');
    const submit = page.getByRole('button', { name: 'Send ride request' });
    await submit.click();
    await expect(submit).toBeDisabled();
    await expect(form.getByRole('status')).toHaveText('Saving ride request…');
    await form.evaluate(element => { (element as HTMLFormElement).requestSubmit(); });
    expect(requests).toBe(1);
    release();
    await expect(form.getByRole('status')).toContainText('not confirmed');
    expect(requests).toBe(1);
  });

  test('preserves the resident-visible Spanish accessibility label verbatim in the handoff payload', async ({ page }) => {
    let submitted: Record<string, unknown> | undefined;
    await page.route('**/api/v1/rides', async route => {
      submitted = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: '{"state":"waiting_for_dispatcher","send_state":"sent"}',
      });
    });
    await openRide(page, 'es');
    const wheelchair = page.locator('input[name="accessibility"][value="wheelchair"]');
    const label = wheelchair.locator('xpath=ancestor::label');
    const primaryLabel = label.locator('[data-catalog-key="rides.accessibility.wheelchair"][data-catalog-render-state]');
    const visibleLabel = (await label.innerText()).replace(/\s+/gu, ' ').trim();
    await expect(primaryLabel).toHaveText('Wheelchair');
    expect(visibleLabel).toBe('Wheelchair Spanish translation is awaiting review.');
    await page.locator('#ride-pickup-at').fill('2030-01-02T10:30');
    await wheelchair.check();
    await page.getByRole('button', { name: 'Send ride request' }).click();
    await expect(page.locator('[data-ride-request-form]').getByRole('status')).toContainText('not confirmed');
    expect(submitted?.accessibility_details).toEqual([{ code: 'wheelchair', label: 'Wheelchair' }]);
  });

  test('server HTML keeps every native field and submit control disabled until hydration', async ({ browser }) => {
    const context = await browser.newContext({ baseURL: BASE_URL, javaScriptEnabled: false });
    try {
      await context.addCookies(preferenceCookies('en', 'easy'));
      const page = await context.newPage();
      const requests: string[] = [];
      page.on('request', request => { if (request.method() !== 'GET') requests.push(`${request.method()} ${request.url()}`); });
      await page.goto('/rides', { waitUntil: 'domcontentloaded' });
      const controls = page.locator('[data-ride-request-form]').locator(formControls);
      expect(await controls.count()).toBe(13);
      for (let index = 0; index < await controls.count(); index += 1) await expect(controls.nth(index)).toBeDisabled();
      await expect(page.locator('[data-ride-request-form]')).not.toHaveAttribute('action', /\S/u);
      expect(requests).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
