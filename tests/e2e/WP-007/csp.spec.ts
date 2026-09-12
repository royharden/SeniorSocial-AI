import { expect, test } from '@playwright/test';

const nonceFrom = (csp: string) => csp.match(/'nonce-([^']+)'/)?.[1] ?? null;

test('each shell response carries a fresh CSP nonce and hydrates without a violation @smoke', async ({ page }) => {
  const cspErrors: string[] = [];
  page.on('console', (message) => {
    if (/content security policy|refused to execute/i.test(message.text())) cspErrors.push(message.text());
  });

  const firstResponse = await page.goto('/home');
  const firstCsp = firstResponse?.headers()['content-security-policy'] ?? '';
  const firstNonce = nonceFrom(firstCsp);
  expect(firstNonce).not.toBeNull();
  expect(await page.locator('script[nonce]').count()).toBeGreaterThan(0);
  expect(await page.locator('script[nonce]').evaluateAll((scripts) =>
    [...new Set(scripts.map((script) => (script as HTMLScriptElement).nonce))],
  )).toEqual([firstNonce]);

  const secondResponse = await page.request.get('/help');
  const secondNonce = nonceFrom(secondResponse.headers()['content-security-policy'] ?? '');
  expect(secondNonce).not.toBeNull();
  expect(secondNonce).not.toBe(firstNonce);
  expect(cspErrors).toEqual([]);
});
