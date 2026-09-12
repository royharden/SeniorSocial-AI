import { expect, test, type Page } from '@playwright/test';
import { BASE_URL, locales, modes, preferenceCookies, routes, viewports } from './route-matrix';

const focusableSelector = [
  'a[href]', 'button:not([disabled]):not(#next-logo)', 'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',');

async function prepare(page: Page, locale: 'en' | 'es', mode: 'standard' | 'easy', path: string) {
  await page.context().addCookies(preferenceCookies(locale, mode));
  const response = await page.goto(path, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  expect(response?.status(), `shared app infrastructure did not render ${path}`).toBeLessThan(500);
  await expect(page.locator('body')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', locale);
  // The ride submit control is server-rendered disabled and enabled by a
  // client effect. Sample the tab set only after that hydration transition.
  if (path === '/rides') await expect(page.getByRole('button', { name: 'Send ride request' })).toBeEnabled({ timeout: 15_000 });
  if (path === '/concierge') {
    await expect(page.getByRole('button', { name: 'Get help finding a service' })).toBeEnabled({ timeout: 15_000 });
  }
}

test.describe('normal-CSP infrastructure classification', () => {
  test('the configured dev origin hydrates with nonce CSP and no CSP console violation', async ({ page }) => {
    const cspErrors: string[] = [];
    page.on('console', message => {
      if (/content security policy|refused to (?:execute|load)/i.test(message.text())) cspErrors.push(message.text());
    });
    const response = await page.goto('/home', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const responseUrl = new URL(response?.url() ?? 'about:blank');
    expect(responseUrl.origin).toBe(new URL(BASE_URL).origin);
    expect(responseUrl.pathname).toBe('/home');
    expect(response?.headers()['content-security-policy']).toMatch(/script-src[^;]*'nonce-[^']+'/);
    await expect(page.locator('.ss-app')).toBeVisible();
    expect(cspErrors, 'shared CSP/dev-origin infrastructure failure (not a product a11y defect)').toEqual([]);
  });
});

for (const locale of locales) {
  for (const mode of modes) {
    test(`all routes have ordered, visible keyboard focus and a working skip target [${locale}/${mode}]`, async ({ page }) => {
      for (const route of routes) {
        await prepare(page, locale, mode, route.path);
        const expected = await page.locator(focusableSelector).evaluateAll(elements => elements.filter(element => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        }).map(element => `${element.tagName.toLowerCase()}#${element.id || '-'}[name=${element.getAttribute('name') ?? '-'}] "${((element as HTMLElement).innerText || element.getAttribute('aria-label') || element.getAttribute('placeholder') || '').trim().slice(0, 80)}"`));
        expect(expected.length, `route ${route.path} must expose at least its skip link`).toBeGreaterThan(0);

        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        const seen = new Set<number>();
        for (let press = 0; press < expected.length * 4 + 10 && seen.size < expected.length; press += 1) {
          await page.keyboard.press('Tab');
          const state = await page.evaluate((selector) => {
            const candidates = [...document.querySelectorAll<HTMLElement>(selector)].filter(element => {
              const style = getComputedStyle(element);
              const rect = element.getBoundingClientRect();
              return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
            });
            const active = document.activeElement as HTMLElement | null;
            const style = active ? getComputedStyle(active) : null;
            const rect = active?.getBoundingClientRect();
            const describe = (element: HTMLElement | undefined | null) => element
              ? `${element.tagName.toLowerCase()}#${element.id || '-'}[name=${element.getAttribute('name') ?? '-'}] "${(element.innerText || element.getAttribute('aria-label') || element.getAttribute('placeholder') || '').trim().slice(0, 80)}"`
              : 'none';
            return {
              actual: describe(active),
              candidateIndex: active ? candidates.indexOf(active) : -1,
              visibleRing: Boolean(style && (style.outlineStyle !== 'none' || style.boxShadow !== 'none')),
              horizontallyVisible: Boolean(rect && rect.left >= -1 && rect.right <= document.documentElement.clientWidth + 1),
            };
          }, focusableSelector);
          if (state.candidateIndex >= 0 && !seen.has(state.candidateIndex)) {
            expect.soft(state.candidateIndex, `${route.path} [${locale}/${mode}] tab order mismatch at ${state.actual}`).toBe(seen.size);
            seen.add(state.candidateIndex);
            expect.soft(state.visibleRing, `${route.path} [${locale}/${mode}] no visible focus indicator on ${state.actual}`).toBe(true);
            expect.soft(state.horizontallyVisible, `${route.path} [${locale}/${mode}] keyboard focus is clipped offscreen: ${state.actual}`).toBe(true);
          }
        }
        const missed = expected.filter((_, index) => !seen.has(index));
        expect.soft(seen.size, `${route.path} [${locale}/${mode}] keyboard traversal did not reach every action; missed: ${missed.join(', ')}`).toBe(expected.length);

        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
        await expect(page.locator('body')).toBeVisible();
        await page.keyboard.press('Tab');
        const skipFocused = await page.evaluate(() => document.activeElement?.matches('a[href="#main"]') === true);
        expect.soft(skipFocused, `${route.path} [${locale}/${mode}] skip link must be the first keyboard target`).toBe(true);
        await page.keyboard.press('Enter');
        const landmark = await page.evaluate(() => ({
          mainCount: document.querySelectorAll('main').length,
          targetCount: document.querySelectorAll('main#main').length,
          targetFocused: document.activeElement?.matches('main#main') === true,
        }));
        expect.soft(landmark.targetFocused, `${route.path} [${locale}/${mode}] skip link must focus main#main; ${JSON.stringify(landmark)}`).toBe(true);
        expect.soft(landmark.mainCount, `${route.path} [${locale}/${mode}] must have exactly one main landmark; ${JSON.stringify(landmark)}`).toBe(1);
      }
    });
  }
}

for (const locale of locales) {
  for (const mode of modes) {
    for (const viewport of viewports) {
      test(`all routes have no clipping or horizontal scroll [${locale}/${mode}/${viewport.name}]`, async ({ page }) => {
        for (const route of routes) {
          await page.setViewportSize(viewport);
          await prepare(page, locale, mode, route.path);
          const overflow = await page.evaluate(() => ({
            clientWidth: document.documentElement.clientWidth,
            scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
            clipped: [...document.querySelectorAll<HTMLElement>('body *')].filter(element => {
              const style = getComputedStyle(element);
              const rect = element.getBoundingClientRect();
              return style.position !== 'fixed' && rect.width > 1 && (rect.left < -1 || rect.right > document.documentElement.clientWidth + 1);
            }).slice(0, 12).map(element => `${element.tagName.toLowerCase()}#${element.id || '-'}[class="${element.className}"]`),
          }));
          expect.soft(overflow.scrollWidth, `${route.path} [${locale}/${mode}/${viewport.name}] horizontal scroll/clipping evidence: ${overflow.clipped.join(', ')}`).toBeLessThanOrEqual(overflow.clientWidth + 1);
          expect.soft(overflow.clipped, `${route.path} [${locale}/${mode}/${viewport.name}] elements extend beyond the viewport`).toEqual([]);

          if (mode === 'easy') {
            const shell = page.locator('.ss-app');
            const shellCount = await shell.count();
            expect.soft(shellCount, `${route.path} [${locale}/${viewport.name}] Easy Mode is unavailable on this user-visible route`).toBe(1);
            const modeAttribute = shellCount ? await shell.getAttribute('data-mode') : null;
            expect.soft(modeAttribute, `${route.path} [${locale}/${viewport.name}] Easy Mode data attribute`).toBe('easy');
            const bodySize = shellCount ? await shell.evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize)) : 0;
            expect.soft(bodySize, `${route.path} [${locale}/${viewport.name}] Easy Mode body text must be at least 22px`).toBeGreaterThanOrEqual(22);
            const undersized = await page.locator('a[href], button:not([disabled]):not(#next-logo), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled])').evaluateAll(elements => elements.flatMap(element => {
              const control = element as HTMLElement;
              const measured = control.matches('input[type="checkbox"], input[type="radio"]') ? control.closest('label') ?? control : control;
              const rect = measured.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0 && (rect.width < 48 || rect.height < 48)
                ? [`${control.tagName.toLowerCase()}#${control.id || '-'}[class=${control.className || '-'}][name=${control.getAttribute('name') ?? '-'}][href=${control.getAttribute('href') ?? '-'}] "${(control.innerText || control.getAttribute('aria-label') || '').trim().slice(0, 60)}" ${rect.width.toFixed(2)}x${rect.height.toFixed(2)}`]
                : [];
            }));
            expect.soft(undersized, `${route.path} [${locale}/${viewport.name}] Easy Mode interactive targets below 48x48 CSS pixels`).toEqual([]);
          }
        }
      });
    }
  }
}

test('every route visibly changes its page content for Spanish', async ({ page }) => {
  for (const route of routes) {
    const content = async (locale: 'en' | 'es') => {
      await page.context().clearCookies();
      await prepare(page, locale, 'standard', route.path);
      const primary = page.locator('.ss-content').first();
      return (await primary.innerText()).replace(/\s+/g, ' ').trim();
    };
    const english = await content('en');
    const spanish = await content('es');
    expect.soft(spanish, `Spanish locale exposes the same page content as English on ${route.path}`).not.toBe(english);
  }
});
