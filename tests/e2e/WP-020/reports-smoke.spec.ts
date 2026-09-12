import { expect, test, type Page } from '@playwright/test';
import { buildCanonicalReport } from '../../../packages/reporting/src/index.ts';

const appUrl = 'http://localhost:3110';
const fixture = buildCanonicalReport({
  asOf: '2026-09-11T12:00:00.000Z',
  facts: [{ period: '2026-09-01T00:00:00.000Z', channel: 'phone', metric: 'requests', count: 3 }],
  coverage: [{
    channel: 'phone',
    completeness: 'partial',
    sourceVersion: 'provider-v1',
    evidence: 'provider.phone.v1',
    coverageFrom: '2026-09-01T00:00:00.000Z',
    coverageTo: '2026-09-02T00:00:00.000Z',
    knownOmission: 'voicemail unavailable',
    overlapUncertainty: 'callers may use web',
  }],
}, { from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z', channels: ['phone'] });

async function mockReport(page: Page) {
  await page.route('**/api/v1/admin/reports/**', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(fixture),
  }));
}

test('@smoke English reports retain protected evidence, filter scope, and export payloads', async ({ page }) => {
  await mockReport(page);
  await page.route('**/api/v1/admin/exports', route => route.fulfill({ status: 202, body: '{}' }));
  await page.goto(`${appUrl}/reports`);

  await expect(page.getByRole('heading', { name: 'Aggregate reports' })).toBeVisible();
  await expect(page.getByRole('form', { name: 'Report filters' })).toBeVisible();
  await expect(page.locator('[data-catalog-affordance]')).toHaveCount(0);
  const suppressedCounts = page.locator('td [data-catalog-key="reports.suppressed"]');
  await expect(suppressedCounts).toHaveCount(2);
  await expect(suppressedCounts).toHaveText(['Suppressed', 'Suppressed']);
  await expect(page.getByText('tenant_aggregate')).toBeVisible();
  await expect(page.getByText('partial')).toBeVisible();
  await expect(page.getByText(fixture.source_version)).toBeVisible();

  await page.locator('input[name="from"]').fill('2026-09-01');
  await page.locator('input[name="to"]').fill('2026-09-02');
  await page.locator('select[name="channel"]').selectOption('phone');
  const filteredRequest = page.waitForRequest(request => request.url().includes('/channel-activity?'));
  await page.getByRole('button', { name: 'Apply filters' }).click();
  const filteredUrl = new URL((await filteredRequest).url());
  expect(filteredUrl.searchParams.get('from')).toBe('2026-09-01T00:00:00.000Z');
  expect(filteredUrl.searchParams.get('to')).toBe('2026-09-02T00:00:00.000Z');
  expect(filteredUrl.searchParams.get('channel')).toBe('phone');

  const exportRequest = page.waitForRequest(request => request.url().endsWith('/api/v1/admin/exports'));
  await page.getByRole('button', { name: 'Prepare JSON' }).click();
  expect((await exportRequest).postDataJSON()).toEqual({
    report_name: 'channel-activity',
    format: 'json',
    filters: fixture.filters,
  });
});

test('@smoke draft Spanish shell locale renders governed English with an exactly associated affordance', async ({ page }) => {
  await page.context().addCookies([{ name: 'seniorsocial.locale.v1', value: 'es', url: appUrl }]);
  await mockReport(page);
  await page.goto(`${appUrl}/reports`);

  const title = page.locator('[data-catalog-key="reports.title"][data-catalog-render-state="provisional_english_fallback"]');
  await expect(page.locator('main')).toHaveAttribute('lang', 'es');
  await expect(page.locator('main')).not.toHaveAttribute('data-locale-pending', '');
  await expect(title).toHaveText('Aggregate reports');
  await expect(title.locator('+ small[data-catalog-key="reports.title"]')).toHaveText('Spanish translation is awaiting review.');
  await expect(title.locator('+ small[data-catalog-key="reports.title"]')).toHaveCount(1);
  await expect(page.getByText('Informes agregados')).toHaveCount(0);
});
