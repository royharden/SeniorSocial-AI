import { expect, test, type APIResponse } from '@playwright/test';
import enAuth from '../../../packages/i18n/en/auth.json' with { type: 'json' };
import enCommon from '../../../packages/i18n/en/common.json' with { type: 'json' };
import enProfile from '../../../packages/i18n/en/profile.json' with { type: 'json' };
import enShell from '../../../packages/i18n/en/shell.json' with { type: 'json' };
import policy from '../../../packages/i18n/es/catalog-policy.json' with { type: 'json' };
import esAuth from '../../../packages/i18n/es/auth.json' with { type: 'json' };
import { resolveCatalogMessage } from '../../../packages/i18n/src/catalogs';

const allowedIdentical = new Set(policy.approved_source_identical_values.map(entry => entry.key));
const englishValues = Object.entries({ auth: enAuth, common: enCommon, profile: enProfile, shell: enShell })
  .flatMap(([namespace, catalog]) => Object.entries(catalog)
    .filter(([key]) => !allowedIdentical.has(`${namespace}.${key}`))
    .map(([, value]) => value));
const currentShellRoutes = ['/home', '/help', '/settings', '/preferences/confirm?mode=easy'];

type AuthProblemCode = keyof typeof esAuth;

async function expectSpanishProblem(
  response: APIResponse,
  status: number,
  code: AuthProblemCode,
): Promise<void> {
  expect(response.status()).toBe(status);
  expect(response.headers()['content-language']).toBe('es');
  expect(response.headers()['content-type']).toMatch(/^application\/problem\+json/iu);
  await expect(response.json()).resolves.toMatchObject({
    type: `urn:seniorsocial:problem:${code}`,
    code,
    title: esAuth[code],
    status,
  });
}

test.describe('WP-032 current Spanish shell @smoke', () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies([{
      name: 'seniorsocial.locale.v1',
      value: 'es',
      url: 'http://127.0.0.1:3110',
    }]);
  });

  test('Playwright can load the public catalogs entry and observes shipped critical holds', () => {
    // what_bug_this_catches: Node ESM test discovery rejecting JSON imports before any browser test can run.
    expect(resolveCatalogMessage({ locale: 'es', namespace: 'caregiver', key: 'consent.heading' })).toMatchObject({
      renderedLocale: 'en', critical: true, renderState: 'held_english_fallback',
      fallbackReason: 'critical_not_approved', affordance: policy.critical_fallback.affordance,
    });
  });

  test('shell locale persists while provisional help copy falls back honestly', async ({ page }) => {
    // what_bug_this_catches: navigation resetting locale or a blanket no-English assertion encouraging unapproved Spanish help copy.
    for (const route of currentShellRoutes) {
      await page.goto(route);
      await expect(page.locator('html')).toHaveAttribute('lang', 'es');
      if (route === '/help') continue;
      const renderedSurface = [
        await page.locator('body').innerText(),
        ...(await page.locator('[aria-label]').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label') ?? ''))),
      ].join('\n');
      for (const english of englishValues) expect(renderedSurface).not.toContain(english);
    }

    await page.goto('/home');
    await expect(page.getByRole('heading', { name: 'Encuentre ayuda comunitaria en un solo lugar' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Configuración' })).toBeVisible();

    await page.goto('/help');
    await expect(page.getByRole('heading', { name: 'Talk with a person' })).toBeVisible();
    await expect(page.getByText('Choose a service below. This page does not promise that a queue is staffed.')).toBeVisible();
    await expect(page.locator('[data-catalog-affordance]').first()).toBeVisible();

    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Sus ajustes' })).toBeVisible();
    await page.getByRole('button', { name: /Más grande y sencillo/u }).first().click();
    await expect(page.getByRole('heading', { name: 'Confirme su opción de pantalla' })).toBeVisible();
    await expect(page.getByRole('status').last()).toContainText('Usted eligió: Más grande y sencillo');
    await expect(page.getByRole('button', { name: 'Sí, use esta opción' })).toBeVisible();
  });

  test('caregiver route preserves Spanish shell locale and holds provisional critical copy in English', async ({ context, page }) => {
    // what_bug_this_catches: navigation resetting the persisted locale or rendering unapproved caregiver consent Spanish without its English-only affordance.
    await context.addCookies([{
      name: 'seniorsocial.locale.v1',
      value: 'es',
      url: 'http://localhost:3110',
    }]);
    await page.goto('http://localhost:3110/caregiver');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'es');
    await expect(page.getByRole('navigation', { name: 'Navegación principal' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Caregiver access' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Permission read-back' })).toBeVisible();
    const held = page.locator('[data-catalog-affordance="held_english_fallback"]');
    await expect(held.first()).toBeVisible();
    expect(await held.count()).toBeGreaterThan(0);
    await expect(held.first()).toContainText('available in English only');
  });

  test('staff API stays nondisclosing without disturbing the resident Spanish locale', async ({ context, page }) => {
    // what_bug_this_catches: a locale cookie bypassing staff authorization or an administrative denial clearing the persisted locale.
    await page.goto('/home');
    await expect(page.locator('html')).toHaveAttribute('lang', 'es');
    const response = await context.request.get('/api/v1/admin/translations', { maxRedirects: 0 });
    expect(response.status()).toBe(404);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'es');
    await expect(page.getByRole('heading', { name: 'Revisión de la traducción al español' })).toHaveCount(0);
  });

  test('auth Problem responses use exact Spanish titles, stable codes, and a Spanish language header', async ({ context }) => {
    // what_bug_this_catches: locale-aware shell navigation still returning English auth errors or translated machine codes.
    expect(esAuth).toEqual({
      invalid_request: 'Solicitud no válida',
      rate_limited: 'Demasiados intentos de autenticación',
      invalid_credential: 'La credencial de inicio de sesión no es válida o venció',
      invalid_demo_code: 'El código de demostración no es válido o venció',
      session_required: 'Se requiere una sesión iniciada',
      invalid_session: 'Su sesión no es válida o venció',
    });
    for (const route of ['/auth/magic-link', '/auth/sms-code', '/auth/verify', '/auth/demo-code']) {
      const response = await context.request.post(route, { data: {}, maxRedirects: 0 });
      await expectSpanishProblem(response, 422, 'invalid_request');
    }
    await expectSpanishProblem(await context.request.get('/auth/session', { maxRedirects: 0 }), 401, 'session_required');
  });
});
