import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { preferenceCookies } from './route-matrix';

for (const locale of ['en', 'es'] as const) {
  for (const mode of ['standard', 'easy'] as const) {
    test.describe(`caregiver axe [${locale}/${mode}]`, () => {
      test.use({ bypassCSP: true });
      test('has no automated accessibility violations', async ({ context, page }) => {
        await context.addCookies(preferenceCookies(locale, mode));
        const response = await page.goto('/caregiver', { waitUntil: 'domcontentloaded' });
        expect(response?.status()).toBe(200);
        await expect(page.locator('#caregiver-title')).toBeVisible();
        const results = await new AxeBuilder({ page }).analyze();
        expect(results.violations.map(({ id, nodes }) => ({ id, targets: nodes.map(node => node.target) }))).toEqual([]);
      });
    });
  }
}

test('caregiver EN/ES safety copy, Easy Mode targets, and keyboard flow stay accessible', async ({ context, page }) => {
  // what_bug_this_catches: Spanish mode can expose unreviewed consent text, while mouse-only controls and a nested main hide the failure from the happy path.
  const requests: Array<{ method: string; payload: unknown; url: string }> = [];
  await page.route('**/api/v1/caregiver/**', async route => {
    const request = route.request();
    requests.push({
      method: request.method(),
      payload: request.postDataJSON() as unknown,
      url: request.url(),
    });
    await route.fulfill({ status: request.method() === 'POST' ? 201 : 200, contentType: 'application/json', body: '{}' });
  });
  await context.addCookies(preferenceCookies('es', 'easy'));
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto('/caregiver', { waitUntil: 'domcontentloaded' });
  const caregiverStatus = page.locator('.ss-content').getByRole('status');

  await expect(page.locator('.ss-app')).toHaveAttribute('data-locale', 'es');
  await expect(page.locator('#caregiver-title > span')).toHaveText('Caregiver access');
  await expect(page.locator('main')).toHaveCount(1);
  await expect(page.locator('main#main')).toHaveCount(1);
  await expect(page.locator('#permissions-title > span')).toHaveAttribute('lang', 'en');
  await expect(page.locator('[data-catalog-affordance="held_english_fallback"]').first()).toHaveText('available in English only');
  await expect(page.getByText('Repaso de permisos', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Acceso para una persona cuidadora', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Send invitation/iu })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Guardar estos permisos exactos' })).toHaveCount(0);

  const easyMeasurements = await page.evaluate(() => ({
    bodyText: Number.parseFloat(getComputedStyle(document.querySelector<HTMLElement>('.ss-app')!).fontSize),
    affordanceText: [...document.querySelectorAll<HTMLElement>('[data-catalog-affordance]')]
      .map(element => Number.parseFloat(getComputedStyle(element).fontSize)),
    controls: [...document.querySelectorAll<HTMLElement>('.ss-content button, .ss-content input')].map(control => {
      const measured = control.matches('input[type="checkbox"]') ? control.closest('label') ?? control : control;
      const rect = measured.getBoundingClientRect();
      return { height: rect.height, width: rect.width };
    }),
    viewport: document.documentElement.clientWidth,
    pageWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
  }));
  expect(easyMeasurements.bodyText).toBeGreaterThanOrEqual(22);
  expect(easyMeasurements.affordanceText.length).toBeGreaterThan(0);
  expect(easyMeasurements.affordanceText.every(size => size >= 22)).toBe(true);
  expect(easyMeasurements.controls.every(({ height, width }) => height >= 48 && width >= 48)).toBe(true);
  expect(easyMeasurements.pageWidth).toBeLessThanOrEqual(easyMeasurements.viewport + 1);

  await page.locator('#caregiver-recipient').focus();
  await page.keyboard.type('helper@example.test');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Neighbor');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: /Send invitation/iu })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(caregiverStatus).toContainText('Invitation created');

  await page.locator('#caregiver-link').focus();
  await page.keyboard.type('10000000-0000-4000-8000-000000000032');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Space');
  await expect(page.getByRole('checkbox', { name: /View schedule/iu })).toBeChecked();
  await page.getByRole('checkbox', { name: /I am the resident and I confirm these exact permissions/iu }).focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: /Save these exact permissions/iu })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(caregiverStatus).toHaveText('The selected permissions were saved.');
  await expect(caregiverStatus.locator('[data-catalog-key="caregiver.consent.permissions_saved"]'))
    .toHaveAttribute('aria-describedby', 'caregiver-critical-translation-state');
  await expect(page.locator('#caregiver-critical-translation-state')).toHaveText('available in English only');

  await page.getByRole('button', { name: /Revoke all caregiver access/iu }).focus();
  await page.keyboard.press('Space');
  await expect(caregiverStatus).toHaveText('All caregiver access was revoked.');
  await expect(caregiverStatus.locator('[data-catalog-key="caregiver.consent.revoked"]'))
    .toHaveAttribute('aria-describedby', 'caregiver-critical-translation-state');

  expect(requests).toHaveLength(3);
  expect(requests[0]).toMatchObject({ method: 'POST', payload: { email_or_phone: 'helper@example.test', relationship_note: 'Neighbor' } });
  expect(requests[1]).toMatchObject({
    method: 'PUT',
    payload: {
      read_back_confirmed: true,
      scopes: [
        { key: 'view_schedule', granted: true },
        { key: 'book_rides', granted: false },
        { key: 'receive_alerts', granted: false },
        { key: 'view_assistance', granted: false },
        { key: 'view_profile', granted: false },
      ],
    },
  });
  expect(requests[1]?.url).toContain('/links/10000000-0000-4000-8000-000000000032/scopes');
  expect(requests[2]).toMatchObject({ method: 'DELETE' });
  expect(requests[2]?.url).toContain('/links/10000000-0000-4000-8000-000000000032');
});

test('caregiver waits for the response, blocks concurrent edits, and reports failed consent truthfully', async ({ context, page }) => {
  // what_bug_this_catches: a pending or rejected save announces success, permits changed consent, or leaves controls disabled.
  let releaseResponse = () => {};
  const responseGate = new Promise<void>(resolve => { releaseResponse = resolve; });
  await page.route('**/api/v1/caregiver/links/*/scopes', async route => {
    await responseGate;
    await route.fulfill({ status: 503, contentType: 'application/problem+json', body: '{"detail":"caregiver_unavailable"}' });
  });
  await context.addCookies(preferenceCookies('en', 'easy'));
  await page.goto('/caregiver', { waitUntil: 'domcontentloaded' });
  const status = page.locator('.ss-content').getByRole('status');
  const save = page.getByRole('button', { name: 'Save these exact permissions' });
  const form = page.locator('form').filter({ has: page.locator('#caregiver-link') });
  await expect(status).toBeEmpty();
  await expect(page.getByRole('button', { name: 'Revoke all caregiver access' })).toBeDisabled();
  await page.locator('#caregiver-link').fill('10000000-0000-4000-8000-000000000032');
  await page.getByRole('checkbox', { name: 'View schedule', exact: true }).check();
  await save.click();
  await expect(form).toHaveAttribute('aria-busy', 'false');
  await expect(status).toBeEmpty();
  await page.getByRole('checkbox', { name: /I am the resident and I confirm these exact permissions/iu }).check();
  await save.click();
  await expect(form).toHaveAttribute('aria-busy', 'true');
  for (const control of await page.locator('.ss-content input, .ss-content button').all()) {
    await expect(control).toBeDisabled();
  }
  await expect(status).toBeEmpty();
  releaseResponse();
  await expect(status).toHaveText('The selected permissions could not be saved.');
  await expect(form).toHaveAttribute('aria-busy', 'false');
  await expect(save).toBeEnabled();
  await expect(page.getByRole('checkbox', { name: 'View schedule', exact: true })).toBeChecked();
});

test.describe('caregiver before hydration', () => {
  test.use({ javaScriptEnabled: false });
  test('does not enable native form submission of contact or consent in a URL', async ({ page }) => {
    // what_bug_this_catches: server-rendered forms submit sensitive fields through the default GET before React attaches.
    await page.goto('/caregiver');
    const controls = page.locator('.ss-content input, .ss-content button');
    expect(await controls.count()).toBeGreaterThan(0);
    for (const control of await controls.all()) await expect(control).toBeDisabled();
  });
});
