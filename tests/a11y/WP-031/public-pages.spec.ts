import { expect, test } from '@playwright/test';
import { locales, modes, preferenceCookies, viewports } from './route-matrix';

const publicRoutes = ['/', '/services', '/concierge'] as const;

test.describe('public pages before hydration', () => {
  test.use({ javaScriptEnabled: false });

  for (const locale of locales) {
    for (const mode of modes) {
      for (const viewport of viewports) {
        test(`SSR exposes AppShell preferences and layout [${locale}/${mode}/${viewport.name}]`, async ({ context, page }) => {
          // what_bug_this_catches: a client-only public shell renders the wrong language/mode before hydration and leaves the root skip target absent.
          await context.addCookies(preferenceCookies(locale, mode));
          await page.setViewportSize(viewport);
          for (const path of publicRoutes) {
            const response = await page.goto(path, { waitUntil: 'domcontentloaded' });
            expect(response?.status(), path).toBe(200);
            const shell = page.locator('.ss-app');
            await expect(shell, path).toHaveCount(1);
            await expect(shell, path).toHaveAttribute('data-locale', locale);
            await expect(shell, path).toHaveAttribute('data-mode', mode);
            await expect(page.locator('main'), path).toHaveCount(1);
            await expect(page.locator('main#main'), path).toHaveCount(1);

            const layout = await page.evaluate(() => ({
              bodySize: Number.parseFloat(getComputedStyle(document.querySelector<HTMLElement>('.ss-app')!).fontSize),
              pageWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
              viewportWidth: document.documentElement.clientWidth,
              undersized: [...document.querySelectorAll<HTMLElement>('.ss-app a[href], .ss-app button, .ss-app input, .ss-app textarea')]
                .flatMap(control => {
                  const measured = control.matches('input[type="checkbox"], input[type="radio"]') ? control.closest('label') ?? control : control;
                  const rect = measured.getBoundingClientRect();
                  return rect.width > 0 && rect.height > 0 && (rect.width < 48 || rect.height < 48)
                    ? [`${control.tagName.toLowerCase()}#${control.id || '-'} ${Math.round(rect.width)}x${Math.round(rect.height)}`]
                    : [];
                }),
            }));
            expect(layout.pageWidth, `${path} horizontal overflow`).toBeLessThanOrEqual(layout.viewportWidth + 1);
            if (mode === 'easy') {
              expect(layout.bodySize, `${path} Easy Mode body size`).toBeGreaterThanOrEqual(22);
              expect(layout.undersized, `${path} Easy Mode target size`).toEqual([]);
            }
          }
        });
      }
    }
  }
});

for (const locale of locales) {
  for (const mode of modes) {
    test(`concierge keeps AI start and ask reachable with a pre-existing answer region [${locale}/${mode}]`, async ({ context, page }) => {
      // what_bug_this_catches: shell/catalog changes can leave the AI-enabled branch untested, or create its live answer container only after the response arrives.
      const conversationId = '10000000-0000-4000-8000-000000000033';
      const answerText = 'A verified service-directory answer.';
      let submittedQuestion: unknown;
      await page.route('**/api/v1/concierge/conversations', route => route.fulfill({
        status: 201, contentType: 'application/json', body: JSON.stringify({ id: conversationId, turns: [], ai_enabled: true }),
      }));
      await page.route(`**/api/v1/concierge/conversations/${conversationId}/messages`, async route => {
        submittedQuestion = route.request().postDataJSON();
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ text: answerText, citations: ['service-031'], disclaimer: 'Directory details can change.' }),
        });
      });
      await page.route(`**/api/v1/concierge/conversations/${conversationId}`, route => route.fulfill({
        status: 200, contentType: 'application/json', body: JSON.stringify({ id: conversationId, turns: [], ai_enabled: true }),
      }));
      await context.addCookies(preferenceCookies(locale, mode));
      await page.goto('/concierge', { waitUntil: 'domcontentloaded' });

      const status = page.locator('main#main').getByRole('status');
      const alert = page.locator('main#main').getByRole('alert');
      await expect(status).toBeEmpty();
      await expect(alert).toBeEmpty();
      await page.getByRole('button', { name: 'Get help finding a service' }).click();

      const answerRegion = page.locator('main#main section[aria-live="polite"][aria-relevant="additions text"]');
      await expect(answerRegion).toBeEmpty();
      await page.locator('#concierge-question').fill('meal delivery');
      await page.getByRole('button', { name: 'Search' }).click();
      await expect(answerRegion).toContainText(answerText);
      await expect(answerRegion).toContainText('service-031');
      expect(submittedQuestion).toEqual({ text: 'meal delivery', locale });
      await expect(alert).toBeEmpty();
    });

    test(`concierge keeps AI-off directory and confirmed human handoff [${locale}/${mode}]`, async ({ context, page }) => {
      // what_bug_this_catches: accessibility shell work can accidentally hide the human path when AI is disabled or announce only a newly-created result node.
      const conversationId = '10000000-0000-4000-8000-000000000031';
      const assistanceId = '10000000-0000-4000-8000-000000000032';
      await page.route('**/api/v1/concierge/conversations', route => route.fulfill({
        status: 201, contentType: 'application/json', body: JSON.stringify({ id: conversationId, turns: [], ai_enabled: false }),
      }));
      await page.route(`**/api/v1/concierge/conversations/${conversationId}/handoff`, route => route.fulfill({
        status: 201, contentType: 'application/json', body: JSON.stringify({ id: assistanceId, org_id: '10000000-0000-4000-8000-000000000030', state: 'pending_unowned' }),
      }));
      await context.addCookies(preferenceCookies(locale, mode));
      await page.goto('/concierge', { waitUntil: 'domcontentloaded' });

      const status = page.locator('main#main').getByRole('status');
      const alert = page.locator('main#main').getByRole('alert');
      await expect(status).toBeEmpty();
      await expect(alert).toBeEmpty();
      await expect(page.getByRole('button', { name: 'Get help finding a service' })).toBeEnabled({ timeout: 15_000 });
      await page.getByRole('button', { name: 'Get help finding a service' }).click();
      await expect(status).toHaveText('Search verified local service information.');
      await expect(page.getByRole('link', { name: 'Browse services' })).toBeVisible();
      await expect(page.locator('#human-handoff')).toHaveText(locale === 'es'
        ? 'Request assistance available in English only'
        : 'Request assistance');
      if (locale === 'es') {
        const handoff = page.locator('section[aria-labelledby="human-handoff"]');
        const heldMessages = handoff.locator('[data-catalog-message="held_english_fallback"]');
        const heldCount = await heldMessages.count();
        expect(heldCount).toBeGreaterThan(0);
        for (const heldMessage of await heldMessages.all()) {
          const catalogKey = await heldMessage.getAttribute('data-catalog-key');
          expect(catalogKey).toBeTruthy();
          const adjacentAffordance = heldMessage.locator('xpath=following-sibling::*[1][self::small]');
          await expect(adjacentAffordance).toHaveCount(1);
          await expect(adjacentAffordance).toHaveAttribute('data-catalog-key', catalogKey!);
          await expect(adjacentAffordance).toHaveAttribute('data-catalog-affordance', 'held_english_fallback');
          await expect(adjacentAffordance).toHaveText('available in English only');
        }
      }

      await page.getByRole('checkbox', { name: 'Yes, use this choice' }).check();
      await page.getByRole('button', { name: 'Send assistance request' }).click();
      await expect(status).toContainText(assistanceId);
      await expect(status).toContainText('pending');
      await expect(alert).toBeEmpty();
    });
  }
}

test('service search remains a keyboard form and reports the server result', async ({ page }) => {
  // what_bug_this_catches: wrapping the public service page in AppShell can drop the GET query or strand its result outside the live outcome container.
  await page.goto('/services', { waitUntil: 'domcontentloaded' });
  await page.locator('#service-query').fill('food delivery');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page).toHaveURL(/\/services\?q=food(?:\+|%20)delivery/u);
  await expect(page.locator('[aria-live="polite"]').getByRole('alert').or(page.getByText('No matching services were found.'))).toBeVisible();
});

test('Spanish public-page copy uses catalog review fallback instead of unreviewed page strings', async ({ context, page }) => {
  // what_bug_this_catches: a local page dictionary bypasses catalog review state and silently ships draft Spanish safety or service copy.
  await context.addCookies(preferenceCookies('es', 'standard'));
  for (const path of publicRoutes) {
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.ss-content [data-catalog-message]').first(), path).toHaveAttribute('lang', 'en');
    await expect(page.locator('.ss-content [data-catalog-affordance]').first(), path).toContainText(/awaiting review|not yet reviewed/iu);
  }
});
