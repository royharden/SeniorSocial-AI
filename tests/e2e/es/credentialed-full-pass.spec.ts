import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import {
  catalogs, resolveCatalogMessage, type CatalogKey, type CatalogResolution,
} from '../../../packages/i18n/src/catalogs';
import esCaregiver from '../../../packages/i18n/es/caregiver.json' with { type: 'json' };
import esIntake from '../../../packages/i18n/es/intake.json' with { type: 'json' };
import runtimeBlockers from './cross-role-runtime-blockers.json' with { type: 'json' };
import {
  ADMIN_ID, ADMIN_TOKEN, RESIDENT_TOKEN, STAFF_TOKEN, WEB_URL, caregiverToken,
} from '../journeys/environment.ts';

const cookies = {
  locale: 'seniorsocial.locale.v1',
  mode: 'seniorsocial.display-mode.v1',
  session: 'ss_session',
} as const;
type Locale = 'en' | 'es';

const adminMessage = (locale: Locale, key: CatalogKey<'admin'>) => resolveCatalogMessage({ locale, namespace: 'admin', key });
const eventMessage = (locale: Locale, key: CatalogKey<'events'>) => resolveCatalogMessage({ locale, namespace: 'events', key });
const groupMessage = (locale: Locale, key: CatalogKey<'groups'>) => resolveCatalogMessage({ locale, namespace: 'groups', key });
const intakeMessage = (locale: Locale, key: CatalogKey<'intake'>) => resolveCatalogMessage({ locale, namespace: 'intake', key });
const notifyMessage = (locale: Locale, key: CatalogKey<'notify'>) => resolveCatalogMessage({ locale, namespace: 'notify', key });
const profileMessage = (locale: Locale, key: CatalogKey<'profile'>) => resolveCatalogMessage({ locale, namespace: 'profile', key });
const rideMessage = (locale: Locale, key: CatalogKey<'rides'>) => resolveCatalogMessage({ locale, namespace: 'rides', key });
const serviceMessage = (locale: Locale, key: CatalogKey<'services'>) => resolveCatalogMessage({ locale, namespace: 'services', key });
const translateMessage = (locale: Locale, key: CatalogKey<'translate'>) => resolveCatalogMessage({ locale, namespace: 'translate', key });

async function become(context: BrowserContext, token: string, locale: 'en' | 'es' = 'es') {
  await context.addCookies([
    { name: cookies.locale, value: locale, url: WEB_URL },
    { name: cookies.mode, value: 'standard', url: WEB_URL },
    { name: cookies.session, value: token, url: WEB_URL },
  ]);
}

async function becomePublic(context: BrowserContext, locale: 'en' | 'es') {
  await context.clearCookies({ name: cookies.session });
  await context.addCookies([
    { name: cookies.locale, value: locale, url: WEB_URL },
    { name: cookies.mode, value: 'standard', url: WEB_URL },
  ]);
}

async function expectLocale(page: Page, locale: 'en' | 'es') {
  await expect(page.locator('html')).toHaveAttribute('lang', locale);
  await expect(page.locator('.ss-app')).toHaveAttribute('data-locale', locale);
}

async function expectResolved(page: Page, resolution: CatalogResolution) {
  expect(resolution.found).toBe(true);
  const key = `${resolution.namespace}.${resolution.key}`;
  const text = page.locator(
    `[data-catalog-key="${key}"][data-catalog-render-state="${resolution.renderState}"], `
    + `[data-i18n-key="${key}"][data-render-state="${resolution.renderState}"]`,
  ).filter({ hasText: resolution.text }).first();
  await expect(text).toBeVisible();
  await expect(text).toHaveAttribute('lang', resolution.renderedLocale ?? '');
  if (resolution.affordance === null) return;
  const accessibleOwner = text.locator('xpath=ancestor-or-self::*[@aria-describedby][1]');
  await expect(accessibleOwner, `${key} must have one accessible fallback owner`).toHaveCount(1);
  const ids = (await accessibleOwner.getAttribute('aria-describedby'))?.split(/\s+/u).filter(Boolean) ?? [];
  const matchingIds: string[] = [];
  for (const id of ids) {
    const notice = page.locator(`#${id}`);
    if (await notice.isVisible() && (await notice.textContent())?.trim() === resolution.affordance) {
      matchingIds.push(id);
    }
  }
  expect(matchingIds, `${key} must have exactly one associated visible fallback notice`).toHaveLength(1);
}

async function expectGovernedMarker(page: Page, resolution: CatalogResolution) {
  const key = `${resolution.namespace}.${resolution.key}`;
  const rendered = page.locator(
    `[data-catalog-key="${key}"][data-catalog-render-state="${resolution.renderState}"], `
    + `[data-i18n-key="${key}"][data-render-state="${resolution.renderState}"]`,
  ).filter({ hasText: resolution.text }).first();
  await expect(rendered, `${key} must expose its resolver identity`).toBeVisible();
  await expect(rendered).toHaveAttribute('lang', resolution.renderedLocale ?? '');
  const state = await rendered.getAttribute('data-catalog-render-state') ?? await rendered.getAttribute('data-render-state');
  expect(state, `${key} render state`).toBe(resolution.renderState);
  if (resolution.affordance === null) {
    expect(await rendered.getAttribute('aria-describedby')).toBeNull();
    return;
  }
  const accessibleOwner = rendered.locator('xpath=ancestor-or-self::*[@aria-describedby][1]');
  await expect(accessibleOwner, `${key} must have one accessible fallback owner`).toHaveCount(1);
  const ids = (await accessibleOwner.getAttribute('aria-describedby'))?.split(/\s+/u).filter(Boolean) ?? [];
  const matching = [];
  for (const id of ids) {
    const notice = page.locator(`#${id}`);
    if (await notice.isVisible() && (await notice.textContent())?.trim() === resolution.affordance) matching.push(id);
  }
  expect(matching, `${key} must have exactly one associated visible fallback notice`).toHaveLength(1);
}

test.describe('WP-030/WP-032 credentialed Spanish evidence', () => {
  test('cross-role localization blocker inventory stays empty after consumer reconciliation', () => {
    // what_bug_this_catches: resolved product-owner findings lingering as stale exceptions to the credentialed Spanish gate.
    expect(runtimeBlockers).toEqual([]);
  });

  test('qualified admin creates, reviews, and publishes exact Spanish in the single credentialed stack', async ({ context, page }) => {
    // what_bug_this_catches: a fixture-only approved resolver branch hiding broken production auth, RLS, or publish wiring.
    await become(context, ADMIN_TOKEN);
    const label = (key: CatalogKey<'translate'>) => translateMessage('es', key).text;
    const response = await page.goto('/translate');
    expect(response?.status()).toBe(200);
    await page.getByLabel(label('source_key')).fill('wp032.credentialed.notice');
    await page.getByLabel(label('source_text')).fill('Call the office on September 18, 2026.');
    await page.getByRole('button', { name: label('create_source') }).click();
    await page.getByLabel(label('spanish_text')).fill('Llame a la oficina el 18 de septiembre de 2026.');
    await page.getByRole('button', { name: label('manual') }).click();
    await page.getByLabel(label('review_note')).fill('Revisión cualificada de prueba');
    const approvedResponse = page.waitForResponse(value =>
      value.request().method() === 'POST' && new URL(value.url()).pathname.endsWith('/approve'));
    const approvalRefresh = page.waitForResponse(value =>
      value.request().method() === 'GET' && new URL(value.url()).pathname === '/api/v1/admin/translations');
    await page.getByRole('button', { name: label('approve') }).click();
    expect((await approvedResponse).status()).toBe(200);
    expect((await approvalRefresh).status()).toBe(200);
    const publishedResponse = page.waitForResponse(value =>
      value.request().method() === 'POST'
      && new URL(value.url()).pathname === '/api/v1/admin/translations'
      && (value.request().postDataJSON() as { action?: string } | null)?.action === 'publish');
    await page.getByRole('button', { name: label('publish') }).click();
    expect((await publishedResponse).status()).toBe(200);
    const api = await context.request.get('/api/v1/admin/translations');
    expect(api.status()).toBe(200);
    const body = await api.json() as { items: Array<{
      source: { key: string };
      history: Array<{
        text: string; status: string; reviewedBy: string | null; reviewerQualification: string | null;
        reviewedAt: string | null; publishedBy: string | null; publishedAt: string | null;
      }>;
    }> };
    const source = body.items.find(item => item.source.key === 'wp032.credentialed.notice');
    expect(source).toBeDefined();
    expect(source?.history).toContainEqual(expect.objectContaining({
      text: 'Llame a la oficina el 18 de septiembre de 2026.',
      status: 'approved',
      reviewedBy: ADMIN_ID,
      reviewerQualification: 'Synthetic qualified Spanish reviewer',
      reviewedAt: expect.any(String),
      publishedBy: ADMIN_ID,
      publishedAt: expect.any(String),
    }));
  });

  test('resident navigation preserves locale and wired ordinary drafts disclose review fallback once per surface', async ({ context, page }) => {
    // what_bug_this_catches: a credentialed journey silently rendering provisional Spanish or losing locale between real routes.
    await become(context, RESIDENT_TOKEN);
    const routes = [
      ['/services', (locale: Locale) => serviceMessage(locale, 'directory.heading')],
      ['/events', (locale: Locale) => eventMessage(locale, 'page.heading')],
      ['/rides', (locale: Locale) => rideMessage(locale, 'page.title')],
      ['/concierge', (locale: Locale) => serviceMessage(locale, 'directory.intro')],
    ] as const;
    for (const [route, resolveMessage] of routes) {
      await become(context, RESIDENT_TOKEN, 'es');
      await page.goto(route);
      await expectLocale(page, 'es');
      const resolved = resolveMessage('es');
      expect(resolved).toMatchObject({ renderedLocale: 'en', renderState: 'provisional_english_fallback' });
      await expectResolved(page, resolved);

      await become(context, RESIDENT_TOKEN, 'en');
      await page.reload();
      await expectLocale(page, 'en');
      const english = resolveMessage('en');
      expect(english).toMatchObject({ renderedLocale: 'en', renderState: 'english_source' });
      await expectResolved(page, english);
    }
  });

  test('resident and caregiver critical journeys hold unapproved Spanish copy', async ({ context, page }) => {
    // what_bug_this_catches: a real role/session path bypassing critical-copy review even though resolver fixtures pass.
    await become(context, RESIDENT_TOKEN);
    await page.goto('/help');
    await expectLocale(page, 'es');
    const assistance = resolveCatalogMessage({ locale: 'es', namespace: 'assistance', key: 'emergency.heading' });
    expect(assistance).toMatchObject({ critical: true, renderedLocale: 'en', renderState: 'held_english_fallback' });
    await expect(page.getByText(assistance.text, { exact: true })).toBeVisible();

    for (const kind of ['legal', 'health'] as const) {
      await page.goto(`/intake/${kind}`);
      const key = `disclaimer.${kind}` as const;
      const intake = resolveCatalogMessage({ locale: 'es', namespace: 'intake', key });
      expect(intake).toMatchObject({ critical: true, renderedLocale: 'en', renderState: 'held_english_fallback' });
      const held = page.getByText(intake.text, { exact: true });
      await expect(held).toBeVisible();
      await expect(held).toHaveAttribute('lang', 'en');
      await expect(page.getByText(esIntake[key], { exact: true })).toHaveCount(0);
      await expect(page.getByText(intake.affordance!, { exact: true })).toHaveCount(2);
    }

    await become(context, caregiverToken(0));
    await page.goto('/caregiver');
    await expectLocale(page, 'es');
    const consent = resolveCatalogMessage({ locale: 'es', namespace: 'caregiver', key: 'consent.heading' });
    expect(consent).toMatchObject({ critical: true, renderedLocale: 'en', renderState: 'held_english_fallback' });
    await expect(page.getByText(consent.text, { exact: true })).toBeVisible();
    await expect(page.getByText(esCaregiver['consent.heading'], { exact: true })).toHaveCount(0);
  });

  test('resident, caregiver, staff, and admin sessions retain the Spanish boundary without widening staff access', async ({ context, page }) => {
    // what_bug_this_catches: tests claiming a full Spanish pass with anonymous pages or a resident token standing in for every role.
    for (const [token, route, expectedStatus] of [
      [RESIDENT_TOKEN, '/home', 200],
      [caregiverToken(1), '/caregiver', 200],
      [STAFF_TOKEN, '/reports', 200],
      [ADMIN_TOKEN, '/admin', 200],
    ] as const) {
      await become(context, token);
      const response = await page.goto(route);
      expect(response?.status()).toBe(expectedStatus);
      await expect(page.locator('html')).toHaveAttribute('lang', 'es');
      if (route !== '/reports') await expect(page.locator('.ss-app')).toHaveAttribute('data-locale', 'es');
    }
    await become(context, ADMIN_TOKEN);
    expect((await context.request.get('/api/v1/admin/users')).status()).toBe(200);
    await become(context, STAFF_TOKEN);
    expect((await context.request.get('/api/v1/admin/reports/channel-activity')).status()).toBe(403);
    await become(context, ADMIN_TOKEN);
    expect((await context.request.get('/api/v1/admin/reports/channel-activity')).status()).toBe(200);
  });

  test('approval-aware consumers expose provisional and critical-held states to real roles', async ({ context, page }) => {
    // what_bug_this_catches: route-level language cookies passing while consumers omit resolver provenance or accessible fallback ownership.
    await become(context, RESIDENT_TOKEN);
    for (const [route, resolveMessage, shippedSpanish] of [
      ['/settings', (locale: Locale) => profileMessage(locale, 'settings_heading'), catalogs.es.profile.settings_heading],
      ['/events', (locale: Locale) => eventMessage(locale, 'page.heading'), catalogs.es.events['page.heading']],
      ['/intake', (locale: Locale) => intakeMessage(locale, 'disclaimer.health'), catalogs.es.intake['disclaimer.health']],
      ['/groups', (locale: Locale) => groupMessage(locale, 'title'), catalogs.es.groups.title],
      ['/groups', (locale: Locale) => groupMessage(locale, 'safety_notice'), catalogs.es.groups.safety_notice],
    ] as const) {
      await page.goto(route);
      const resolution = resolveMessage('es');
      await expectGovernedMarker(page, resolution);
      if (resolution.critical && resolution.renderedLocale === 'en') {
        const english = resolveMessage('en');
        expect(resolution.text).toBe(english.text);
        if (shippedSpanish !== resolution.text) await expect(page.getByText(shippedSpanish, { exact: true })).toHaveCount(0);
      }
    }

    await become(context, ADMIN_TOKEN);
    for (const [route, resolveMessage] of [
      ['/admin', (locale: Locale) => adminMessage(locale, 'page.title')],
      ['/admin', (locale: Locale) => adminMessage(locale, 'queue.moderation')],
      ['/translate', (locale: Locale) => translateMessage(locale, 'title')],
    ] as const) {
      await page.goto(route);
      await expectGovernedMarker(page, resolveMessage('es'));
    }
  });

  test('notification settings and print preserve governed locale provenance', async ({ context, page }) => {
    // what_bug_this_catches: notification/print consumers regressing to raw strings after their adoption blockers were closed.
    await become(context, RESIDENT_TOKEN);
    for (const [route, headingKey] of [
      ['/settings/notifications', 'settings.title'],
      ['/print', 'print.title'],
    ] as const) {
      await page.goto(route);
      await expectLocale(page, 'es');
      await expectGovernedMarker(page, notifyMessage('es', headingKey));
    }
    const printable = await context.request.get('/api/v1/me/schedule/print');
    expect(printable.status()).toBe(200);
    const snapshot = await printable.json() as { as_of: string; source_version: string; items: unknown[] };
    expect(snapshot.source_version).toMatch(/^schedule:/u);
    expect(Date.parse(snapshot.as_of)).not.toBeNaN();
    expect(snapshot.items).toBeInstanceOf(Array);
    const inbox = await context.request.get('/api/v1/notifications');
    expect(inbox.status()).toBe(200);
    expect(inbox.headers()['content-type']).toMatch(/^application\/json/u);
  });

  test('every shipped MVP page has role-bound EN and ES route reachability evidence', async ({ context, page }) => {
    // what_bug_this_catches: calling a representative subset a complete cross-role matrix while pages or roles remain unvisited.
    test.setTimeout(420_000);
    const routes = [
      ['/', null], ['/services', null], ['/home', RESIDENT_TOKEN], ['/settings', RESIDENT_TOKEN],
      ['/settings/data-export', RESIDENT_TOKEN],
      ['/settings/notifications', RESIDENT_TOKEN], ['/help', RESIDENT_TOKEN], ['/events', RESIDENT_TOKEN],
      ['/caregiver', caregiverToken(2)], ['/rides', RESIDENT_TOKEN],
      ['/preferences/confirm?mode=easy', RESIDENT_TOKEN], ['/print', RESIDENT_TOKEN],
      ['/services', RESIDENT_TOKEN], ['/concierge', RESIDENT_TOKEN], ['/intake', RESIDENT_TOKEN],
      ['/intake/legal', RESIDENT_TOKEN], ['/intake/health', RESIDENT_TOKEN], ['/messages', RESIDENT_TOKEN],
      ['/groups', RESIDENT_TOKEN], ['/admin', ADMIN_TOKEN], ['/reports', STAFF_TOKEN],
      ['/translate', ADMIN_TOKEN],
    ] as const;
    for (const locale of ['en', 'es'] as const) {
      for (const [route, token] of routes) {
        if (token === null) await becomePublic(context, locale); else await become(context, token, locale);
        const response = await page.goto(route);
        expect(response?.status(), `${locale} ${route}`).toBe(200);
        await expect(page.locator('html')).toHaveAttribute('lang', locale);
        if (route === '/reports' || route === '/translate') {
          await expect(page.locator('.ss-app')).toHaveCount(0);
        } else await expect(page.locator('.ss-app')).toHaveAttribute('data-locale', locale);
      }
    }
  });
});
