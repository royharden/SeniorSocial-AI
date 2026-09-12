import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { BASE_URL, locales, modes, preferenceCookies, viewports } from './route-matrix';

async function openHelp(page: Page, locale: 'en' | 'es' = 'en', mode: 'standard' | 'easy' = 'standard') {
  await page.context().addCookies(preferenceCookies(locale, mode));
  const response = await page.goto(`${BASE_URL}/help`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  expect(response?.status()).toBe(200);
  await expect(page.locator('[data-assistance-form] button[type="submit"]')).toBeEnabled({ timeout: 15_000 });
}

async function installAnnouncementRecorder(page: Page) {
  await page.addInitScript(() => {
    const records: string[] = [];
    const record = (node: Node) => {
      const element = node instanceof Element ? node : node.parentElement;
      const live = element?.closest('[data-assistance-status][aria-live]');
      const text = live?.textContent?.replace(/\s+/gu, ' ').trim();
      if (text) records.push(text);
    };
    new MutationObserver(mutations => mutations.forEach(mutation => {
      record(mutation.target);
      mutation.addedNodes.forEach(record);
    })).observe(document, { subtree: true, childList: true, characterData: true });
    Object.defineProperty(window, '__helpAnnouncements', { value: records });
  });
}

async function announcementTexts(page: Page) {
  return page.evaluate(() => (window as typeof window & { __helpAnnouncements?: string[] }).__helpAnnouncements ?? []);
}

test.describe('WP-031 /help focused accessibility contract', () => {
  test.use({ bypassCSP: true });

  for (const locale of locales) {
    for (const mode of modes) {
      test(`is axe-clean and preserves emergency guidance [${locale}/${mode}]`, async ({ page }) => {
        await openHelp(page, locale, mode);
        const results = await new AxeBuilder({ page }).include('main#main').analyze();
        expect(results.violations.map(({ id }) => id)).toEqual([]);
        await expect(page.locator('html')).toHaveAttribute('lang', locale);
        await expect(page.locator('span[data-catalog-key="assistance.emergency.heading"]')).toHaveText('Emergency help');
        await expect(page.locator('span[data-catalog-key="assistance.emergency.disclaimer"]')).toHaveText('SeniorSocial is not an emergency service and does not monitor requests continuously.');
        await expect(page.locator('a[href="tel:911"] span[data-catalog-key="assistance.emergency.call_911"]')).toHaveText('Call 911');
        await expect(page.locator('span[data-catalog-key="assistance.request.unassigned_notice"]')).toHaveText('Submitting creates an unassigned request. It does not guarantee a response.');
      });
    }
  }

  for (const viewport of viewports) {
    test(`Easy Mode controls are 48px and do not clip [${viewport.name}]`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await openHelp(page, 'en', 'easy');
      const controls = page.locator('[data-assistance-form]').locator('textarea, button');
      const undersized = await controls.evaluateAll(elements => elements.flatMap(element => {
        const rect = element.getBoundingClientRect();
        return rect.width < 48 || rect.height < 48 ? [`${element.tagName.toLowerCase()} ${rect.width}x${rect.height}`] : [];
      }));
      expect(undersized).toEqual([]);
      const geometry = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      }));
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
    });
  }

  test('keyboard order reaches both controls with visible focus', async ({ page }) => {
    await openHelp(page, 'en', 'easy');
    await page.locator('main#main').focus();
    const seen: string[] = [];
    for (let press = 0; press < 20 && seen.length < 2; press += 1) {
      await page.keyboard.press('Tab');
      const state = await page.evaluate(() => {
        const active = document.activeElement as HTMLElement | null;
        if (!active?.closest('[data-assistance-form]')) return null;
        const style = getComputedStyle(active);
        return { id: active.id || active.tagName.toLowerCase(), ring: style.outlineStyle !== 'none' || style.boxShadow !== 'none' };
      });
      if (state && !seen.includes(state.id)) {
        expect(state.ring, `missing visible focus on ${state.id}`).toBe(true);
        seen.push(state.id);
      }
    }
    expect(seen).toEqual(['assistance-summary', 'button']);
  });

  test('one pre-existing live region announces repeated saves, success, and failure', async ({ page }) => {
    await installAnnouncementRecorder(page);
    let attempt = 0;
    let releaseSuccess = () => {};
    const successGate = new Promise<void>(resolve => { releaseSuccess = resolve; });
    await page.route('**/api/v1/assistance-requests', async route => {
      attempt += 1;
      if (attempt === 1) {
        await successGate;
        await route.fulfill({ status: 201, contentType: 'application/json', body: '{"id":"10000000-0000-4000-8000-000000000014","state":"pending_unowned","after_hours":false}' });
      } else {
        await route.fulfill({ status: 503, contentType: 'application/problem+json', body: '{}' });
      }
    });
    await openHelp(page);
    const status = page.locator('[data-assistance-status]');
    await expect(status).toBeEmpty();
    await page.locator('#assistance-summary').fill('Accessibility audit synthetic request');
    await page.getByRole('button', { name: 'Send assistance request' }).click();
    await expect(status).toHaveText('Sending request…');
    releaseSuccess();
    await expect(status).toContainText('Your request was saved');
    await expect(status).toContainText('It is pending and not yet assigned.');
    await expect(status).toContainText('A staff response or callback is not guaranteed.');
    const firstSaveAnnouncements = (await announcementTexts(page)).filter(text => text === 'Sending request…').length;
    expect(firstSaveAnnouncements).toBeGreaterThanOrEqual(1);
    await page.getByRole('button', { name: 'Send assistance request' }).click();
    await expect(status).toHaveAttribute('role', 'alert');
    await expect(status).toHaveText('The assistance request could not be saved.');

    const records = await announcementTexts(page);
    expect(records.filter(text => text === 'Sending request…').length).toBeGreaterThan(firstSaveAnnouncements);
    expect(records.some(text => text.includes('Your request was saved')
      && text.includes('It is pending and not yet assigned.')
      && text.includes('A staff response or callback is not guaranteed.'))).toBe(true);
    expect(records).toContain('The assistance request could not be saved.');
  });

  test('keeps the assistance API, idempotency header, and payload stable across retry', async ({ page }) => {
    const requests: Array<{ headers: Record<string, string>; payload: Record<string, unknown>; url: string }> = [];
    await page.route('**/api/v1/assistance-requests', async route => {
      requests.push({ headers: route.request().headers(), payload: route.request().postDataJSON() as Record<string, unknown>, url: route.request().url() });
      await route.fulfill(requests.length === 1
        ? { status: 503, contentType: 'application/problem+json', body: '{}' }
        : { status: 201, contentType: 'application/json', body: '{"id":"10000000-0000-4000-8000-000000000014","state":"pending_unowned","after_hours":true}' });
    });
    await openHelp(page, 'es', 'easy');
    await page.locator('#assistance-summary').fill('Necesito ayuda con alimentos');
    const submit = page.getByRole('button', { name: 'Send assistance request' });
    await submit.click();
    await expect(page.locator('[data-assistance-status]')).toHaveAttribute('role', 'alert');
    await submit.click();
    await expect(page.locator('[data-assistance-status]')).toContainText('Your request was saved');

    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toMatch(/\/api\/v1\/assistance-requests$/u);
    expect(requests[0]?.headers['content-type']).toBe('application/json');
    expect(requests[0]?.headers['idempotency-key']).toBeTruthy();
    expect(requests[1]?.headers['idempotency-key']).toBe(requests[0]?.headers['idempotency-key']);
    expect(requests[0]?.payload).toEqual({ summary: 'Necesito ayuda con alimentos', locale: 'es' });
    expect(requests[1]?.payload).toEqual(requests[0]?.payload);
  });
});
