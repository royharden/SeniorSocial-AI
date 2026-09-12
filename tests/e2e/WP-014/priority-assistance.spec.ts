import { expect, test } from '@playwright/test';
import { resolveCatalogMessage } from '../../../packages/i18n/src/catalogs';

test.setTimeout(60_000);

test('@smoke emergency guidance remains visible throughout assistance intake', async ({ page }) => {
  await page.goto('/help');
  await expect(page.getByRole('heading', { name: 'Emergency help' })).toBeVisible();
  await expect(page.getByText('SeniorSocial is not an emergency service and does not monitor requests continuously.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Call 911' })).toBeVisible();
  await page.getByLabel('How can staff assist you?').fill('I need help with groceries');
  await expect(page.getByRole('heading', { name: 'Emergency help' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Call 911' })).toBeVisible();
  await expect(page.getByText('Submitting creates an unassigned request. It does not guarantee a response.')).toBeVisible();
});

test('@smoke Spanish assistance holds critical copy in English with truthful locale and affordance', async ({ context, page }) => {
  // what_bug_this_catches: a Spanish locale rendering unreviewed critical assistance copy or hiding its English-only state.
  await context.addCookies([{
    name: 'seniorsocial.locale.v1', value: 'es', url: 'http://127.0.0.1:3110',
  }]);
  await page.goto('/help');

  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  const helpHeading = resolveCatalogMessage({ locale: 'es', namespace: 'shell', key: 'help_heading' });
  expect(helpHeading).toMatchObject({
    renderedLocale: 'en', renderState: 'provisional_english_fallback',
    fallbackReason: 'provisional_translation', affordance: 'Spanish translation is awaiting review.',
  });
  await expect(page.locator('[data-catalog-key="shell.help_heading"][data-catalog-render-state="provisional_english_fallback"]'))
    .toHaveText(helpHeading.text);
  await expect(page.locator('[data-catalog-key="shell.help_heading"][data-catalog-affordance="provisional_english_fallback"]'))
    .toHaveText('Spanish translation is awaiting review.');
  const criticalKeys = [
    'emergency.heading', 'emergency.disclaimer', 'emergency.call_911',
    'request.form_heading', 'request.details_label', 'request.unassigned_notice', 'request.send',
  ] as const;
  for (const key of criticalKeys) {
    const resolution = resolveCatalogMessage({ locale: 'es', namespace: 'assistance', key });
    expect(resolution).toMatchObject({
      renderedLocale: 'en', renderState: 'held_english_fallback',
      fallbackReason: 'critical_not_approved', affordance: 'available in English only',
    });
    const rendered = page.locator(`[data-catalog-key="assistance.${key}"][data-catalog-render-state="held_english_fallback"]`);
    await expect(rendered).toHaveText(resolution.text);
    await expect(rendered).toHaveAttribute('lang', 'en');
    await expect(rendered).toHaveAttribute('data-catalog-fallback-reason', 'critical_not_approved');
    await expect(page.locator(`[data-catalog-key="assistance.${key}"][data-catalog-affordance="held_english_fallback"]`))
      .toHaveText('available in English only');
  }

  await expect(page.getByRole('link', { name: /Call 911/iu })).toBeVisible();
  await page.getByLabel(/How can staff assist you\?/iu).fill('Necesito ayuda humana');
  await expect(page.getByRole('link', { name: /Call 911/iu })).toBeVisible();
  await expect(page.getByRole('button', { name: /Send assistance request/iu })).toBeVisible();
  await expect(page.getByText('SeniorSocial no es un servicio de emergencia y no supervisa las solicitudes continuamente.')).toHaveCount(0);
});
