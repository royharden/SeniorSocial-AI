import { expect, test } from '@playwright/test';

const webUrl = process.env.WEB_URL ?? 'http://localhost:3110';
const submissionId = '88888888-8888-4888-8888-888888888888';

test.describe('WP-018 legal and health intake @smoke', () => {
  test('shows both legal disclaimers before submit and saves an entirely optional draft', async ({ page }) => {
    let savedBody: Record<string, unknown> | undefined;
    let idempotencyKey: string | undefined;
    await page.route('**/api/v1/intake/legal', async route => {
      savedBody = await route.request().postDataJSON() as Record<string, unknown>;
      idempotencyKey = route.request().headers()['idempotency-key'];
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({
        id: submissionId, kind: 'legal', state: 'draft', answers: {}, locale: 'en', disclaimer_acknowledged: false,
      }) });
    });

    await page.goto(`${webUrl}/intake/legal`);
    const disclaimer = page.getByRole('heading', { name: 'Important limitation' }).locator('..');
    await expect(disclaimer.getByText('This form does not create an attorney-client relationship and is not legal advice.')).toBeVisible();
    await expect(disclaimer.locator('[data-catalog-affordance]')).toHaveCount(0);
    await expect(page.locator('main [data-catalog-affordance]')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Call 911' })).toHaveAttribute('href', 'tel:911');

    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page.locator('p[role="status"]')).toContainText('Saved form number');
    expect(savedBody).toEqual({
      locale: 'en', answers: {}, disclaimer_acknowledged: false, intent: 'save_draft',
    });
    expect(idempotencyKey).toBeTruthy();
    await expect(page).toHaveURL(new RegExp(`submissionId=${submissionId}$`));
  });

  test('requires acknowledgment and reports only the server-named partner category', async ({ page }) => {
    let submitCount = 0;
    await page.route('**/api/v1/intake/health', async route => {
      submitCount += 1;
      const body = await route.request().postDataJSON() as Record<string, unknown>;
      expect(body).toMatchObject({
        locale: 'en', disclaimer_acknowledged: true, intent: 'submit',
        answers: { topic: 'home_support' },
      });
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({
        id: submissionId, kind: 'health', state: 'routed', routed_to_partner_category: 'Community health navigation',
      }) });
    });

    await page.goto(`${webUrl}/intake/health`);
    await page.getByLabel('What do you need help with?').selectOption('home_support');
    await page.getByRole('button', { name: 'Submit for routing' }).click();
    await expect(page.locator('p[role="status"]')).toContainText('Please read and check the acknowledgment');
    expect(submitCount).toBe(0);

    const acknowledgment = page.getByLabel(/I understand that this form is not medical advice or emergency care/);
    await acknowledgment.focus();
    await page.keyboard.press('Space');
    await expect(acknowledgment).toBeChecked();
    const sendButton = page.getByRole('button', { name: 'Submit for routing' });
    await sendButton.focus();
    await page.keyboard.press('Enter');
    const routeNotice = page.locator('p').filter({ hasText: 'Routed Community health navigation' });
    await expect(routeNotice).toContainText('Community health navigation');
    await expect(page.locator('p[role="status"]')).toContainText('This does not confirm eligibility or an appointment');
    expect(submitCount).toBe(1);
  });

  test('loads and updates a Spanish draft while keeping blank optional fields blank', async ({ page, context }) => {
    await context.addCookies([
      { name: 'seniorsocial.locale.v1', value: 'es', domain: 'localhost', path: '/' },
      { name: 'seniorsocial.display-mode.v1', value: 'easy', domain: 'localhost', path: '/' },
    ]);
    let patchedBody: Record<string, unknown> | undefined;
    await page.route(`**/api/v1/intake/${submissionId}`, async route => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
          id: submissionId, kind: 'legal', state: 'draft', locale: 'es', disclaimer_acknowledged: true,
          answers: { topic: 'housing' },
        }) });
        return;
      }
      patchedBody = await route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        id: submissionId, kind: 'legal', state: 'draft', locale: 'es', disclaimer_acknowledged: false,
        answers: { topic: 'housing', contact_method: 'phone' },
      }) });
    });

    await page.goto(`${webUrl}/intake/legal?submissionId=${submissionId}`);
    await expect(page.getByRole('heading', { name: 'Legal services intake' })).toBeVisible();
    const intakeRegion = page.getByRole('region', { name: 'Legal services intake' });
    const ordinaryAffordance = intakeRegion.locator('[data-catalog-affordance="provisional_english_fallback"]');
    await expect(ordinaryAffordance).toHaveCount(1);
    const affordanceId = await ordinaryAffordance.getAttribute('id');
    expect(affordanceId).toBeTruthy();
    await expect(intakeRegion.locator('[data-catalog-render-state="provisional_english_fallback"]').first()).toHaveAttribute('aria-describedby', affordanceId!);
    await expect(page.getByText('This form does not create an attorney-client relationship and is not legal advice.')).toBeVisible();
    await expect(page.getByText('Este formulario no crea una relación entre abogado y cliente')).toHaveCount(0);
    const topic = page.getByLabel('What do you need help with?');
    await expect(topic).toHaveValue('housing');
    await expect(page.getByLabel(/I understand that submitting this form does not create an attorney-client relationship/)).toBeChecked();
    expect((await topic.boundingBox())?.height).toBeGreaterThanOrEqual(48);
    await expect(page.locator('.ss-app')).toHaveAttribute('data-mode', 'easy');
    await page.getByLabel('Preferred contact method').selectOption('phone');
    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page.locator('p[role="status"]')).toContainText('Saved form number');
    expect(patchedBody).toEqual({
      locale: 'es',
      answers: { topic: 'housing', contact_method: 'phone' },
      disclaimer_acknowledged: true,
      intent: 'save_draft',
    });
  });

  test('reuses the same idempotency key after an ambiguous save failure', async ({ page }) => {
    const keys: string[] = [];
    let attempt = 0;
    await page.route('**/api/v1/intake/legal', async route => {
      keys.push(route.request().headers()['idempotency-key'] ?? '');
      attempt += 1;
      if (attempt === 1) { await route.abort('failed'); return; }
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({
        id: submissionId, kind: 'legal', state: 'draft', answers: {}, locale: 'en', disclaimer_acknowledged: false,
      }) });
    });

    await page.goto(`${webUrl}/intake/legal`);
    const saveButton = page.getByRole('button', { name: 'Save draft' });
    await saveButton.click();
    await expect(page.locator('p[role="status"]')).toContainText('could not be saved');
    await saveButton.click();
    await expect(page.locator('p[role="status"]')).toContainText('Saved form number');
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe('');
    expect(keys[1]).toBe(keys[0]);
  });
});
