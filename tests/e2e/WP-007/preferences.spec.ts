import { expect, test } from '@playwright/test';

const webUrl = process.env.WEB_URL ?? '';

test.describe('WP-007 persisted preferences @smoke', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${webUrl}/home`);
  });

  test('the person chooses Easy Mode and it survives reload', async ({ page }) => {
    await page.getByRole('button', { name: /Bigger and simpler/i }).first().click();
    await expect(page.getByRole('heading', { name: 'Confirm your display choice' })).toBeVisible();
    await expect(page.getByRole('status').last()).toContainText('You chose: Bigger and simpler');
    expect((await page.context().cookies()).find((cookie) => cookie.name === 'seniorsocial.display-mode.v1')).toBeUndefined();

    await page.getByRole('button', { name: 'Yes, use this choice' }).click();
    await page.reload();
    await expect(page.locator('.ss-app')).toHaveAttribute('data-mode', 'easy');
    await expect(page.locator('.ss-app')).toHaveCSS('font-size', '22px');
    await expect(page.getByRole('navigation', { name: 'Consistent help' })).toBeVisible();
    await expect(page.getByRole('status').first()).toContainText('Current choice: Bigger and simpler');

    await page.reload();

    await expect(page.locator('.ss-app')).toHaveAttribute('data-mode', 'easy');
    await expect(page.getByRole('button', { name: /Bigger and simpler/i }).first()).toHaveAttribute('aria-pressed', 'true');
  });

  test('the person chooses Spanish and it survives reload', async ({ page }) => {
    await page.getByRole('button', { name: 'Español' }).first().click();
    await page.reload();
    await expect(page.locator('.ss-app')).toHaveAttribute('lang', 'es');
    await expect(page.locator('html')).toHaveAttribute('lang', 'es');
    await expect(page.getByText('Borrador automático, todavía no revisado por una persona.')).toBeVisible();

    await page.reload();

    await expect(page.locator('.ss-app')).toHaveAttribute('lang', 'es');
    await expect(page.getByRole('button', { name: 'Español' }).first()).toHaveAttribute('aria-pressed', 'true');
  });
});

test.describe('WP-007 preference write boundary @smoke', () => {
  test('rejects cross-origin and unconfirmed writes without setting cookies', async ({ request }) => {
    const forged = await request.post('/preferences', {
      form: { mode: 'easy', confirm: 'yes' },
      headers: { origin: 'https://evil.example', referer: 'https://evil.example/phish' },
      maxRedirects: 0,
    });
    expect(forged.status()).toBe(403);
    expect(forged.headers()['set-cookie']).toBeUndefined();

    const inferred = await request.post('/preferences', {
      form: { age: '91' },
      headers: {
        origin: 'http://127.0.0.1:3110',
        referer: 'http://127.0.0.1:3110/settings',
      },
      maxRedirects: 0,
    });
    expect(inferred.status()).toBe(400);
    expect(inferred.headers()['set-cookie']).toBeUndefined();
  });

  test('a confirmed write cannot redirect to an external Referer', async ({ request }) => {
    const response = await request.post('/preferences', {
      form: { mode: 'easy', confirm: 'yes' },
      headers: {
        origin: 'http://127.0.0.1:3110',
        referer: 'https://evil.example/phish',
      },
      maxRedirects: 0,
    });
    expect(response.status()).toBe(303);
    const location = new URL(response.headers().location);
    expect(location.pathname).toBe('/home');
    expect(location.hostname).not.toBe('evil.example');
  });
});
