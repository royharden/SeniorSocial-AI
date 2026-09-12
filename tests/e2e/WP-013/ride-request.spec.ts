import { expect, test } from '@playwright/test';

const webUrl = process.env.WEB_URL ?? 'http://localhost:3110';

test.describe('WP-013 truthful ride request @smoke', () => {
  test('preserves structured access needs and never calls a request confirmed', async ({ page }) => {
    const browserErrors: string[] = [];
    page.on('console', message => { if (message.type() === 'error') browserErrors.push(message.text()); });
    page.on('pageerror', error => { browserErrors.push(error.message); });
    let submittedDetails: unknown;
    await page.route('**/api/v1/rides', async route => {
      const submitted = await route.request().postDataJSON() as Record<string, unknown>;
      submittedDetails = submitted.accessibility_details;
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({
        id: '55555555-5555-4555-8555-555555555555', state: 'waiting_for_dispatcher', send_state: 'sent',
      }) });
    });
    await page.goto(`${webUrl}/rides`);
    await expect(page.getByRole('heading', { name: 'Ask for a ride' })).toBeVisible();
    await expect(page.getByText('A request is not a booking.')).toBeVisible();
    await page.waitForTimeout(500);
    expect(browserErrors).toEqual([]);
    await page.getByLabel('Pickup time').fill('2026-11-01T08:30');
    await page.getByLabel('I use a wheelchair').check();
    await page.getByRole('button', { name: 'Send ride request' }).click();
    await expect(page.locator('p[role="status"]')).toContainText('not confirmed yet');
    expect(submittedDetails).toEqual([{ code: 'wheelchair', label: 'I use a wheelchair' }]);
  });

  test('keeps answers visible and states the truth when submission fails', async ({ page }) => {
    await page.route('**/api/v1/rides', route => route.abort('failed'));
    await page.goto(`${webUrl}/rides`);
    await page.getByLabel('Pickup time').fill('2026-11-01T08:30');
    await page.getByLabel('I use a walker').check();
    await page.getByRole('button', { name: 'Send ride request' }).click();
    await expect(page.locator('p[role="status"]')).toContainText('was not sent');
    await expect(page.getByLabel('I use a walker')).toBeChecked();
  });

  test('reuses the idempotency key when an ambiguous failure is retried', async ({ page }) => {
    const keys: string[] = [];
    let attempt = 0;
    await page.route('**/api/v1/rides', async route => {
      keys.push(route.request().headers()['idempotency-key'] ?? '');
      attempt += 1;
      if (attempt === 1) { await route.abort('failed'); return; }
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({
        id: '55555555-5555-4555-8555-555555555555', state: 'waiting_for_dispatcher', send_state: 'sent',
      }) });
    });
    await page.goto(`${webUrl}/rides`);
    await page.getByLabel('Pickup time').fill('2026-11-01T08:30');
    const submit = page.getByRole('button', { name: 'Send ride request' });
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(page.locator('p[role="status"]')).toContainText('was not sent');
    await submit.click();
    await expect(page.locator('p[role="status"]')).toContainText('not confirmed yet');
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe('');
    expect(keys[1]).toBe(keys[0]);
  });
});
