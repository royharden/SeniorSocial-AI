import { expect, test, type Page } from '@playwright/test';

const readyJob = {
  id: '33333333-3333-4333-8333-333333333333', state: 'ready',
  scope: ['profile', 'consents'], completeness_note: 'complete',
  download_url: '/api/v1/admin/exports/33333333-3333-4333-8333-333333333333/download',
  expires_at: '2030-09-12T16:30:00.000Z',
};

async function openExport(page: Page, locale: 'en' | 'es' = 'en', mode: 'standard' | 'easy' = 'standard') {
  await page.context().addCookies([
    { name: 'seniorsocial.locale.v1', value: locale, url: 'http://localhost:3110' },
    { name: 'seniorsocial.display-mode.v1', value: mode, url: 'http://localhost:3110' },
  ]);
  const response = await page.goto('http://localhost:3110/settings/data-export', { waitUntil: 'domcontentloaded' });
  expect(response?.status()).toBe(200);
  await expect(page.locator('[data-data-export] button[type="submit"]')).toBeEnabled({ timeout: 10_000 });
}

test('settings links the EN and ES resident export journey', async ({ page }) => {
  test.setTimeout(30_000);
  for (const locale of ['en', 'es'] as const) {
    await page.context().clearCookies();
    await page.context().addCookies([{ name: 'seniorsocial.locale.v1', value: locale, url: 'http://localhost:3110' }]);
    await page.goto('http://localhost:3110/settings', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('link', { name: locale === 'es' ? 'Exportar sus datos' : 'Export your data' })).toHaveAttribute('href', '/settings/data-export');
  }
});

test('posts one scoped request and exposes only the server-returned ready URL and metadata', async ({ page }) => {
  const requests: Array<{ body: unknown; key: string | undefined }> = [];
  await page.route('**/api/v1/admin/exports', async route => {
    requests.push({ body: route.request().postDataJSON(), key: route.request().headers()['idempotency-key'] });
    await new Promise(resolve => setTimeout(resolve, 100));
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify(readyJob) });
  });
  await openExport(page);
  await page.getByLabel('Consent choices and history').check();
  await page.getByRole('button', { name: 'Create data export' }).dblclick();
  await expect(page.locator('[data-export-status]')).toHaveText('Your export is ready.');
  expect(requests).toHaveLength(1);
  expect(requests[0]?.body).toEqual({ scope: ['profile', 'consents'], format: 'json' });
  expect(requests[0]?.key).toMatch(/^[0-9a-f-]{36}$/u);
  await expect(page.getByText('Profile, Consent choices and history')).toBeVisible();
  await expect(page.getByText('complete', { exact: true })).toBeVisible();
  await expect(page.locator('[data-export-summary] dt', { hasText: 'Export request expires' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Download your export' })).toHaveAttribute('href', readyJob.download_url);
  await expect(page.getByText('Sep 12, 2030', { exact: false })).toBeVisible();
  await expect(page.getByText(/tenant|channel activity/iu)).toHaveCount(0);
});

test('CSV selection is sent as ExportRequest without actor or tenant claims', async ({ page }) => {
  let body: Record<string, unknown> = {};
  await page.route('**/api/v1/admin/exports', async route => {
    body = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ ...readyJob, scope: ['requests'], completeness_note: 'complete with all authorized request records' }) });
  });
  await openExport(page);
  await page.getByLabel('Profile').uncheck();
  await page.getByLabel('Service requests').check();
  await page.getByLabel('CSV (ZIP archive)').check();
  await page.getByRole('button', { name: 'Create data export' }).click();
  await expect(page.locator('[data-export-status]')).toHaveText('Your export is ready.');
  expect(body).toEqual({ scope: ['requests'], format: 'csv' });
  expect(body).not.toHaveProperty('orgId');
  expect(body).not.toHaveProperty('userId');
  expect(body).not.toHaveProperty('subjectId');
  await expect(page.getByText('CSV', { exact: true })).toBeVisible();
});

test('an exact retry reuses its idempotency key and is re-announced', async ({ page }) => {
  const keys: string[] = [];
  let requestCount = 0;
  await page.route('**/api/v1/admin/exports', async route => {
    requestCount += 1;
    keys.push(route.request().headers()['idempotency-key'] ?? '');
    if (requestCount < 3) await route.fulfill({ status: 503, contentType: 'application/problem+json', body: '{}' });
    else await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ ...readyJob, scope: ['profile'] }) });
  });
  await openExport(page);
  const button = page.getByRole('button', { name: 'Create data export' });
  await button.click();
  await expect(page.locator('[data-export-status]')).toHaveText('The export could not be created. You can try the same request again.');
  await page.getByLabel('Consent choices and history').check();
  await button.click();
  await expect(page.locator('[data-export-status]')).toHaveText('The export could not be created. You can try the same request again.');
  await page.getByLabel('Consent choices and history').uncheck();
  await button.click();
  await expect(page.locator('[data-export-status]')).toHaveText('Your export is ready.');
  expect(keys).toHaveLength(3);
  expect(keys[1]).not.toBe(keys[0]);
  expect(keys[2]).toBe(keys[0]);
});

test('pending, failed, malformed, and revoked outcomes never fabricate a download link', async ({ page }) => {
  test.setTimeout(60_000);
  let downloadRequests = 0;
  await page.route('**/api/v1/admin/exports/*/download', route => {
    downloadRequests += 1;
    return route.fulfill({ status: 200, contentType: 'application/octet-stream', body: 'must-not-be-fetched' });
  });
  for (const outcome of [
    { status: 202, body: { ...readyJob, state: 'running', download_url: null, completeness_note: 'generation in progress' } },
    { status: 202, body: { ...readyJob, state: 'failed', download_url: null, completeness_note: 'failed without artifact' } },
    { status: 202, body: { state: 'ready', download_url: '/invented' } },
    { status: 202, body: { ...readyJob, download_url: null } },
    { status: 202, body: { ...readyJob, download_url: 'javascript:alert(1)' } },
    { status: 202, body: { ...readyJob, download_url: '//attacker.example/export' } },
    { status: 202, body: { ...readyJob, download_url: 'https://attacker.example/export' } },
    { status: 202, body: { ...readyJob, download_url: '/api/v1/admin/exports/not-a-job/download' } },
    { status: 202, body: { ...readyJob, download_url: '/api/v1/admin/exports/44444444-4444-4444-8444-444444444444/download' } },
    { status: 202, body: { ...readyJob, download_url: `${readyJob.download_url}?disposition=inline` } },
    { status: 404, body: { type: 'about:blank', title: 'Not Found', status: 404 } },
    { status: 410, body: { type: 'about:blank', title: 'Gone', status: 410 } },
  ]) {
    await page.unroute('**/api/v1/admin/exports');
    await page.route('**/api/v1/admin/exports', route => route.fulfill({
      status: outcome.status, contentType: 'application/json', body: JSON.stringify(outcome.body),
    }));
    await openExport(page);
    await page.getByRole('button', { name: 'Create data export' }).click();
    await expect(page.locator('[data-export-status]')).not.toHaveText('');
    await expect(page.getByRole('link', { name: 'Download your export' })).toHaveCount(0);
    if ('state' in outcome.body && outcome.body.state === 'failed') {
      await expect(page.locator('[data-export-summary] h2')).toHaveText('The export could not be created. You can try the same request again.');
    }
  }
  expect(downloadRequests).toBe(0);
});

test('a running response stays pending without polling a derived status or download API', async ({ page }) => {
  const requests: Array<{ method: string; pathname: string }> = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/v1/admin/exports')) requests.push({ method: request.method(), pathname: url.pathname });
  });
  await page.route('**/api/v1/admin/exports', route => route.fulfill({
    status: 202, contentType: 'application/json',
    body: JSON.stringify({ ...readyJob, state: 'running', download_url: null, completeness_note: 'generation in progress' }),
  }));
  await openExport(page);
  await page.getByRole('button', { name: 'Create data export' }).click();
  await expect(page.locator('[data-export-status]')).toHaveText('Your export request is pending.');
  await page.waitForTimeout(500);
  expect(requests).toEqual([{ method: 'POST', pathname: '/api/v1/admin/exports' }]);
});

test('Spanish critical replay and revocation text remain governed English fallbacks', async ({ page }) => {
  let count = 0;
  await page.route('**/api/v1/admin/exports', route => {
    count += 1;
    return route.fulfill({ status: count === 1 ? 503 : 410, contentType: 'application/problem+json', body: '{}' });
  });
  await openExport(page, 'es');
  const button = page.getByRole('button', { name: 'Crear exportación de datos' });
  await button.click();
  await expect(page.locator('[data-export-status]')).toHaveText('The export could not be created. You can try the same request again.');
  await expect(page.locator('[data-export-status] [lang="en"][data-render-state="held_english_fallback"]')).toBeVisible();
  await expect(page.locator('[data-i18n-affordance="held_english_fallback"]')).toBeVisible();
  await button.click();
  await expect(page.locator('[data-export-status]')).toHaveText('Export unavailable.');
  await expect(page.locator('[data-export-status] [lang="en"][data-render-state="held_english_fallback"]')).toBeVisible();
  await expect(page.locator('[data-i18n-affordance="held_english_fallback"]')).toBeVisible();
  await expect(page.getByRole('link', { name: /Descargar/u })).toHaveCount(0);
});
