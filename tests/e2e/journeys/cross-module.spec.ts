import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import {
  resolveCatalogMessage, type CatalogMessageRequest, type CatalogResolution,
} from '../../../packages/i18n/src/catalogs';
import {
  ADMIN_TOKEN, FOREIGN_RESIDENT_TOKEN, RESIDENT_ID, RESIDENT_TOKEN, STAFF_ID, STAFF_TOKEN, WEB_URL,
  caregiverToken, eventId, linkId, matrix, type DisplayMode, type Locale,
} from './environment.ts';

const cookieNames = { locale: 'seniorsocial.locale.v1', mode: 'seniorsocial.display-mode.v1', session: 'ss_session' } as const;

async function residentSurface(context: BrowserContext, locale: Locale, mode: DisplayMode) {
  await context.addCookies([
    { name: cookieNames.locale, value: locale, url: WEB_URL },
    { name: cookieNames.mode, value: mode, url: WEB_URL },
    { name: cookieNames.session, value: RESIDENT_TOKEN, url: WEB_URL },
  ]);
}

async function roleContext(context: BrowserContext, token: string) {
  await context.addCookies([{ name: cookieNames.session, value: token, url: WEB_URL }]);
}

type NotificationItem = { purpose?: string; title?: string; body?: string };

async function listAllNotifications(page: Page): Promise<NotificationItem[]> {
  const items: NotificationItem[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const response = await page.request.get(`/api/v1/notifications${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
    expect(response.status(), '[WP-009 notifications] resident reminder inbox must be publicly readable').toBe(200);
    const body = await response.json() as { items: NotificationItem[]; meta: { next_cursor: string | null } };
    items.push(...body.items);
    cursor = body.meta.next_cursor;
    if (cursor) expect(seen.has(cursor), '[WP-009 notifications] pagination cursor must advance').toBe(false);
    if (cursor) seen.add(cursor);
  } while (cursor);
  return items;
}

async function assertResidentPresentation(page: Page, locale: Locale, mode: DisplayMode) {
  const shell = page.locator('.ss-app');
  await expect(page.locator('html'), '[ui-shell] document-level language must follow the resident locale').toHaveAttribute('lang', locale);
  await expect(shell, '[ui-shell] locale must survive the complete resident journey').toHaveAttribute('data-locale', locale);
  await expect(shell, '[ui-shell] Easy Mode must remain the same product journey').toHaveAttribute('data-mode', mode);
  await expect(shell, '[ui-shell] the document language must match the selected locale').toHaveAttribute('lang', locale);
  await expect(page.locator('.ss-easy-bar'), '[ui-shell] only resident Easy Mode has the persistent human-help boundary')
    .toHaveCount(mode === 'easy' ? 1 : 0);
}

function localize(locale: Locale, english: string, spanish: string): string {
  return locale === 'es' ? spanish : english;
}

function assistanceMessage(locale: Locale, key: CatalogMessageRequest<'assistance'>['key']): CatalogResolution {
  return resolveCatalogMessage({ locale, namespace: 'assistance', key });
}

function caregiverMessage(locale: Locale, key: CatalogMessageRequest<'caregiver'>['key']): CatalogResolution {
  return resolveCatalogMessage({ locale, namespace: 'caregiver', key });
}

function eventMessage(locale: Locale, key: CatalogMessageRequest<'events'>['key']): CatalogResolution {
  return resolveCatalogMessage({ locale, namespace: 'events', key });
}

function rideMessage(locale: Locale, key: CatalogMessageRequest<'rides'>['key']): CatalogResolution {
  return resolveCatalogMessage({ locale, namespace: 'rides', key });
}

function assertRideResolution(locale: Locale, resolution: CatalogResolution) {
  if (locale === 'es') {
    const englishSource = rideMessage('en', resolution.key as CatalogMessageRequest<'rides'>['key']);
    expect(resolution).toMatchObject({
      requestedLocale: 'es', namespace: 'rides', text: englishSource.text, renderedLocale: 'en', reviewStatus: 'draft',
      renderState: 'provisional_english_fallback', fallbackReason: 'provisional_translation',
      affordance: 'Spanish translation is awaiting review.',
    });
    return;
  }
  expect(resolution).toMatchObject({
    requestedLocale: 'en', namespace: 'rides', renderedLocale: 'en', renderState: 'english_source',
    fallbackReason: null, affordance: null,
  });
}

function serviceMessage(locale: Locale, key: CatalogMessageRequest<'services'>['key']): CatalogResolution {
  return resolveCatalogMessage({ locale, namespace: 'services', key });
}

function commonMessage(locale: Locale, key: CatalogMessageRequest<'common'>['key']): CatalogResolution {
  return resolveCatalogMessage({ locale, namespace: 'common', key });
}

function shellMessage(locale: Locale, key: CatalogMessageRequest<'shell'>['key']): CatalogResolution {
  return resolveCatalogMessage({ locale, namespace: 'shell', key });
}

function interpolateResolution(resolution: CatalogResolution, replacements: Readonly<Record<string, string>>): CatalogResolution {
  if (!resolution.found) throw new Error(`[i18n] missing ${resolution.namespace}.${resolution.key}`);
  let text = resolution.text;
  for (const [token, replacement] of Object.entries(replacements)) text = text.replace(`{${token}}`, replacement);
  return { ...resolution, text };
}

async function assertAssociatedAffordance(rendered: Locator, resolution: CatalogResolution, owner: string) {
  let accessibleOwner = rendered.locator('xpath=ancestor-or-self::*[@aria-describedby][1]');
  if (!resolution.affordance) {
    await expect(accessibleOwner).toHaveCount(0);
    return;
  }
  if (await accessibleOwner.count() === 0) {
    accessibleOwner = rendered.locator('xpath=../*[@aria-describedby][1]');
  }
  const accessibleOwnerCount = await accessibleOwner.count();
  let matching: Locator;
  if (accessibleOwnerCount === 1) {
    const describedBy = await accessibleOwner.getAttribute('aria-describedby');
    expect(describedBy, `[${owner}] ${resolution.namespace}.${resolution.key} must own its visible fallback notice`).toMatch(/\S/u);
    const ids = describedBy!.trim().split(/\s+/u);
    const describedNotices = rendered.page().locator(
      ids.map(id => `#${id.replace(/[^a-zA-Z0-9_-]/gu, '\\$&')}`).join(', '),
    ).filter({ hasText: resolution.affordance });
    const key = `${resolution.namespace}.${resolution.key}`;
    const keySpecificNotice = describedNotices.and(
      rendered.page().locator(`[data-catalog-key="${key}"], [data-catalog-keys~="${key}"]`),
    );
    matching = await keySpecificNotice.count() === 0 ? describedNotices : keySpecificNotice;
  } else {
    expect(accessibleOwnerCount, `[${owner}] ${resolution.namespace}.${resolution.key} accessible owners`).toBe(0);
    matching = rendered.locator('xpath=following-sibling::*[@data-catalog-affordance][1]')
      .filter({ hasText: resolution.affordance });
  }
  await expect(matching, `[${owner}] associated fallback must be visible exactly once`).toHaveCount(1);
  await expect(matching).toBeVisible();
  await expect(matching).toHaveText(resolution.affordance);
}

async function assertEventRendering(scope: Locator, resolution: CatalogResolution) {
  const rendered = scope.getByText(resolution.text, { exact: true });
  await expect(rendered).toBeVisible();
  await expect(rendered).toHaveAttribute('lang', resolution.renderedLocale ?? '');
  await expect(rendered).toHaveAttribute('data-render-state', resolution.renderState);
  await assertAssociatedAffordance(rendered, resolution, 'WP-012 events');
}

async function assertConciergeRendering(scope: Locator, resolution: CatalogResolution) {
  const rendered = scope.locator(`[data-catalog-key="${resolution.namespace}.${resolution.key}"]`)
    .filter({ hasText: resolution.text }).first();
  await expect(rendered).toBeVisible();
  await expect(rendered).toHaveAttribute('lang', resolution.renderedLocale ?? '');
  await expect(rendered).toHaveAttribute('data-catalog-render-state', resolution.renderState);
  await assertAssociatedAffordance(rendered, resolution, 'WP-011 concierge');
}

async function assertServiceRendering(scope: Locator, resolution: CatalogResolution) {
  const rendered = scope.locator(`[data-catalog-key="${resolution.namespace}.${resolution.key}"]`)
    .filter({ hasText: resolution.text }).first();
  await expect(rendered).toBeVisible();
  await expect(rendered).toHaveAttribute('lang', resolution.renderedLocale ?? '');
  await expect(rendered).toHaveAttribute('data-catalog-render-state', resolution.renderState);
  await assertAssociatedAffordance(rendered, resolution, 'WP-010 services');
}

async function assertCaregiverRendering(scope: Locator, resolution: CatalogResolution) {
  const rendered = scope.locator(`[data-catalog-key="${resolution.namespace}.${resolution.key}"]`)
    .filter({ hasText: resolution.text }).first();
  await expect(rendered).toBeVisible();
  await expect(rendered).toHaveAttribute('lang', resolution.renderedLocale ?? '');
  await expect(rendered, `[WP-017 caregiver] ${resolution.namespace}.${resolution.key} must expose its governed state`)
    .toHaveAttribute('data-catalog-render-state', resolution.renderState);
  await assertAssociatedAffordance(rendered, resolution, 'WP-017 caregiver');
}

async function assertAssistanceMessage(page: Page, locale: Locale, key: CatalogMessageRequest<'assistance'>['key']) {
  const resolution = assistanceMessage(locale, key);
  const rendered = page.locator(`[data-catalog-key="assistance.${key}"][data-catalog-render-state="${resolution.renderState}"]`);
  await expect(rendered, `[WP-014 assistance] ${key} must render the approval-aware catalog result`).toHaveText(resolution.text);
  await expect(rendered).toHaveAttribute('lang', resolution.renderedLocale ?? '');
  await assertAssociatedAffordance(rendered, resolution, 'WP-014 assistance');
  return resolution;
}

async function assertConciergeHumanControls(page: Page, locale: Locale) {
  const intro = serviceMessage(locale, 'directory.intro');
  const directory = shellMessage(locale, 'service_link');
  const handoffHeading = assistanceMessage(locale, 'request.form_heading');
  const handoffNotice = assistanceMessage(locale, 'request.unassigned_notice');
  const confirm = commonMessage(locale, 'confirm');
  const handoff = assistanceMessage(locale, 'request.send');
  await assertConciergeRendering(page.locator('section[aria-labelledby="concierge-heading"] > p').filter({ hasText: intro.text }).first(), intro);
  await assertConciergeRendering(page.getByRole('link', { name: directory.text }), directory);
  await assertConciergeRendering(page.getByRole('heading', { name: handoffHeading.text }), handoffHeading);
  await assertConciergeRendering(page.locator('section[aria-labelledby="human-handoff"] > p'), handoffNotice);
  const confirmInput = page.getByLabel(confirm.text);
  await expect(confirmInput).toBeVisible();
  await assertConciergeRendering(confirmInput.locator('xpath=..'), confirm);
  await assertConciergeRendering(page.getByRole('button', { name: handoff.text }), handoff);
}


const foreign = {
  event: '53000000-0000-4000-9200-000000000030',
  caregiverLink: '53000000-0000-4000-9300-000000000030',
  ride: '53000000-0000-4000-9700-000000000030',
  assistance: '53000000-0000-4000-9800-000000000030',
} as const;

function futureEventId(index: number): string {
  return `53000000-0000-4000-8700-${String(100 + index).padStart(12, '0')}`;
}

for (const [variantIndex, variant] of matrix.entries()) {
  const label = `${variant.locale}/${variant.mode}`;

  test(`[WP-010 services → WP-011 concierge → WP-014 handoff] grounded service help completes (${label}) @smoke`, async ({ context, page }) => {
    await residentSurface(context, variant.locale, variant.mode);
    await test.step('[ui-shell] enter through the resident shell with selected locale and mode', async () => {
      await page.goto('/home');
      await assertResidentPresentation(page, variant.locale, variant.mode);
    });
    await test.step('[WP-010 services] search the real published directory', async () => {
      await page.goto(`/services?q=${variant.locale === 'es' ? 'comida' : 'meal'}`);
      await assertResidentPresentation(page, variant.locale, variant.mode);
      const heading = serviceMessage(variant.locale, 'directory.heading');
      const intro = serviceMessage(variant.locale, 'directory.intro');
      const searchLabel = serviceMessage(variant.locale, 'directory.search_label');
      const searchPlaceholder = serviceMessage(variant.locale, 'directory.search_placeholder');
      const searchAction = serviceMessage(variant.locale, 'directory.search_action');
      const eligibility = serviceMessage(variant.locale, 'directory.eligibility');
      const sourceUpdated = serviceMessage(variant.locale, 'directory.source_updated');
      await assertServiceRendering(page.getByRole('heading', { name: heading.text }), heading);
      await assertServiceRendering(page.locator('section[aria-labelledby="services-heading"] > p').first(), intro);
      await assertServiceRendering(page.locator('label[for="service-query"]'), searchLabel);
  const query = page.getByPlaceholder(searchPlaceholder.text);
      await expect(query).toHaveAttribute('lang', searchPlaceholder.renderedLocale ?? '');
      await expect(query).toHaveAttribute('data-catalog-render-state', searchPlaceholder.renderState);
      await assertAssociatedAffordance(query, searchPlaceholder, 'WP-010 services');
      const search = page.getByRole('button', { name: searchAction.text, exact: true });
      await expect(search).toHaveAttribute('lang', searchAction.renderedLocale ?? '');
      await expect(search).toHaveAttribute('data-catalog-render-state', searchAction.renderState);
      await assertAssociatedAffordance(search, searchAction, 'WP-010 services');
      await expect(page.getByRole('heading', { name: variant.locale === 'es' ? 'Comidas a domicilio' : 'Home-delivered meals' })).toBeVisible();
      await expect(page.getByText(localize(variant.locale,
        'Fresh meals delivered at home', 'Comidas frescas entregadas a domicilio'))).toBeVisible();
      const eligibilityCopy = interpolateResolution(eligibility, {
        summary: variant.locale === 'es' ? 'Llame para confirmar elegibilidad' : 'Call to confirm eligibility',
      });
      await assertServiceRendering(page.locator('article p').filter({ hasText: eligibilityCopy.text }), eligibilityCopy);
      const sourceCopy = interpolateResolution(sourceUpdated, { date: '2026-09-10' });
      await assertServiceRendering(page.locator('article p').filter({ hasText: sourceCopy.text }), sourceCopy);
      await expect(page.getByRole('link', { name: '555-0130' })).toBeVisible();
      await expect(page.getByText(/Foreign tenant secret|Secreto de otro inquilino/u)).toHaveCount(0);
      if (variant.locale === 'es') {
        await expect(page.getByRole('heading', { name: 'Home-delivered meals' }),
          '[WP-010 services] published directory data still uses its genuinely localized Spanish record').toHaveCount(0);
      }
    });
    await test.step('[WP-011 concierge] retrieve a grounded native answer over the public HTTP route', async () => {
      await page.goto('/concierge');
      await assertResidentPresentation(page, variant.locale, variant.mode);
      const heading = serviceMessage(variant.locale, 'directory.heading');
      const start = serviceMessage(variant.locale, 'directory.help_link');
      await assertConciergeRendering(page.getByRole('heading', { name: heading.text }), heading);
      await assertConciergeRendering(page.getByRole('button', { name: start.text, exact: true }), start);
      const started = page.waitForResponse(response => response.url().endsWith('/api/v1/concierge/conversations') && response.request().method() === 'POST');
      await page.getByRole('button', { name: start.text, exact: true }).click();
      const startResponse = await started;
      expect(startResponse.status(), '[WP-011 concierge] browser start POST must accept an intentionally empty body').toBe(201);
      const conversation = await startResponse.json() as { id: string; ai_enabled: boolean };
      expect(conversation.ai_enabled, '[WP-011 concierge] this run must make no provider call').toBe(false);
      await assertConciergeHumanControls(page, variant.locale);
      const answer = await page.evaluate(async ({ id, locale }) => {
        const response = await fetch(`/api/v1/concierge/conversations/${id}/messages`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: locale === 'es' ? 'comida' : 'meal', locale }),
        });
        return { status: response.status, body: await response.json() as { text: string; citations: string[]; prompt_version: string } };
      }, { id: conversation.id, locale: variant.locale });
      expect(answer.status).toBe(200);
      expect(answer.body.citations).toEqual(['53000000-0000-4000-8500-000000000030']);
      expect(answer.body.prompt_version).toBe('native-v1');
      expect(answer.body.text).toContain(variant.locale === 'es' ? 'Comidas a domicilio' : 'Home-delivered meals');
      if (variant.locale === 'es') {
        expect(answer.body.text, '[WP-011 concierge] Spanish grounded answer must not duplicate the English service result')
          .not.toContain('Home-delivered meals');
        expect(answer.body.text, '[WP-011 concierge] Spanish grounded answer must not include English grounded-answer copy')
          .not.toContain('I found these authorized directory services:');
      }
    });
    await test.step('[WP-014 assistance] resident explicitly confirms the human handoff', async () => {
      const confirm = commonMessage(variant.locale, 'confirm');
      const send = assistanceMessage(variant.locale, 'request.send');
      const saved = assistanceMessage(variant.locale, 'request.saved_heading');
      const pending = assistanceMessage(variant.locale, 'request.pending_state');
      await page.getByLabel(confirm.text).check();
      const handoff = page.waitForResponse(response =>
        response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/handoff'));
      await page.getByRole('button', { name: send.text }).click();
      expect((await handoff).status()).toBe(201);
      const status = page.getByRole('main').getByRole('status');
      await expect(status).toContainText(saved.text);
      await expect(status).toContainText(pending.text);
    });
    await test.step('[WP-004 auth/WP-011 concierge] foreign-tenant session is indistinguishable from unauthenticated', async () => {
      const isolated = await page.context().browser()!.newContext({ baseURL: WEB_URL });
      try {
        await roleContext(isolated, FOREIGN_RESIDENT_TOKEN);
        const response = await isolated.request.post('/api/v1/concierge/conversations');
        expect(response.status()).toBe(401);
      } finally { await isolated.close(); }
    });
  });

  test(`[WP-012 events] RSVP and capacity waitlist complete (${label}) @smoke`, async ({ context, page }) => {
    await residentSurface(context, variant.locale, variant.mode);
    const eventSuffix = `${variant.locale}-${variant.mode}`;
    const openEventId = eventId(variantIndex, false);
    const laterEventId = futureEventId(variantIndex);
    const openEventTitle = localize(variant.locale, `Open event ${eventSuffix}`, `Evento abierto ${eventSuffix}`);
    const fullEventTitle = localize(variant.locale, `Full event ${eventSuffix}`, `Evento completo ${eventSuffix}`);
    const eventStatus = page.locator('section[aria-labelledby="events-heading"] > p[role="status"]');
    await test.step('[WP-012 events] load recommendations through the authenticated public route', async () => {
      await page.goto('/events');
      await assertResidentPresentation(page, variant.locale, variant.mode);
      const heading = eventMessage(variant.locale, 'page.heading');
      const aiOff = eventMessage(variant.locale, 'recommendation.ai_off');
      const cancel = eventMessage(variant.locale, 'action.cancel');
      const help = eventMessage(variant.locale, 'proposal.help');
      await assertEventRendering(page.getByRole('heading', { name: heading.text }), heading);
      await expect(page.getByText('Foreign tenant event')).toHaveCount(0);
      await assertEventRendering(eventStatus, aiOff);
      await assertEventRendering(page.getByRole('button', { name: cancel.text }).first(), cancel);
      await assertEventRendering(page.locator('section[aria-labelledby="events-heading"]').getByRole('link', { name: help.text }), help);
      if (variant.locale === 'es') {
        await expect(page.getByRole('heading', { name: `Open event ${eventSuffix}` })).toHaveCount(0);
        await expect(page.getByRole('heading', { name: `Full event ${eventSuffix}` })).toHaveCount(0);
      }
      for (const resolution of [heading, aiOff, cancel, help]) {
        if (resolution.affordance) await expect(page.getByText(resolution.affordance, { exact: true }).first()).toBeVisible();
      }
    });
    await test.step('[WP-012 events] RSVP to an event with capacity', async () => {
      const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name: openEventTitle }) });
      const action = eventMessage(variant.locale, 'action.rsvp');
      const open = eventMessage(variant.locale, 'attendance.open');
      const joined = eventMessage(variant.locale, 'action.joined');
      const reminder = eventMessage(variant.locale, 'action.reminder');
      if (!open.found) throw new Error('[WP-012 events] attendance.open catalog message is required');
      await assertEventRendering(card, { ...open, text: open.text.replace('{count}', '4') });
      await assertEventRendering(card.getByRole('button', { name: action.text, exact: true }), action);
      await card.getByRole('button', { name: action.text, exact: true }).click();
      await assertEventRendering(eventStatus, joined);
      await assertEventRendering(eventStatus, reminder);
    });
    await test.step('[WP-012 events] receive truthful capacity conflict and join the waitlist', async () => {
      const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name: fullEventTitle }) });
      const attend = eventMessage(variant.locale, 'action.rsvp');
      const full = eventMessage(variant.locale, 'attendance.full');
      const waitlistAvailable = eventMessage(variant.locale, 'attendance.waitlist');
      const waitlist = eventMessage(variant.locale, 'action.waitlist');
      const waitlisted = eventMessage(variant.locale, 'status.waitlisted');
      await card.getByRole('button', { name: attend.text, exact: true }).click();
      await assertEventRendering(eventStatus, full);
      await assertEventRendering(eventStatus, waitlistAvailable);
      await card.getByRole('button', { name: waitlist.text }).click();
      await assertEventRendering(eventStatus, waitlisted);
    });
    await test.step('[WP-012 events → WP-009 notifications] RSVP publishes an event-specific localized reminder', async () => {
      const eventResponse = await page.request.get(`/api/v1/events/${openEventId}`);
      expect(eventResponse.status()).toBe(200);
      const event = await eventResponse.json() as { starts_at: string };
      const startsAt = Date.parse(event.starts_at);
      const observedAt = Date.now();
      expect(startsAt, '[WP-012 events] reminder fixture event must not have started').toBeGreaterThan(observedAt);
      expect(startsAt - 86_400_000, '[WP-012 events] reminder fixture must be due at observation time').toBeLessThanOrEqual(observedAt);
      const notices = await listAllNotifications(page);
      const reminder = notices.find(item => item.purpose === 'event_reminder' && JSON.stringify(item).includes(openEventId));
      expect(reminder, `[WP-012 events → WP-009 notifications] RSVP ${openEventId} must publish its own reminder`).toBeDefined();
      const reminderCopy = `${reminder?.title ?? ''} ${reminder?.body ?? ''}`;
      expect(reminderCopy).toMatch(variant.locale === 'es' ? /recordatorio.*evento|evento.*recordatorio/iu : /event.*reminder|reminder.*event/iu);
      if (variant.locale === 'es') expect(reminderCopy).not.toMatch(/\breminder\b/iu);
    });
    await test.step('[WP-012 events → WP-009 notifications] a not-yet-due reminder stays absent', async () => {
      const eventResponse = await page.request.get(`/api/v1/events/${laterEventId}`);
      expect(eventResponse.status()).toBe(200);
      const event = await eventResponse.json() as { starts_at: string };
      const startsAt = Date.parse(event.starts_at);
      const observedAt = Date.now();
      expect(startsAt, '[WP-012 events] future-reminder control event must not have started').toBeGreaterThan(observedAt);
      expect(startsAt - 86_400_000, '[WP-012 events] future-reminder control must not be due').toBeGreaterThan(observedAt);
      const rsvp = await page.request.post(`/api/v1/events/${laterEventId}/rsvp`);
      expect(rsvp.status()).toBe(201);
      const notices = await listAllNotifications(page);
      expect(notices.some(item => item.purpose === 'event_reminder' && JSON.stringify(item).includes(laterEventId)),
        `[WP-012 events → WP-009 notifications] future reminder ${laterEventId} must remain absent`).toBe(false);
    });
    await test.step('[WP-004 auth/WP-012 events] unauthenticated and wrong-role RSVP do not disclose event state', async () => {
      const isolated = await page.context().browser()!.newContext({ baseURL: WEB_URL });
      const caregiver = await page.context().browser()!.newContext({ baseURL: WEB_URL });
      try {
        expect((await isolated.request.get('/api/v1/recommendations/events')).status()).toBe(401);
        await roleContext(caregiver, caregiverToken(variantIndex));
        expect((await caregiver.request.post(`/api/v1/events/${eventId(variantIndex, false)}/rsvp`)).status()).toBe(404);
        expect((await page.request.get(`/api/v1/events/${foreign.event}`)).status()).toBe(404);
      } finally { await isolated.close(); await caregiver.close(); }
    });
  });

  test(`[WP-013 rides] resident request reaches authoritative staff state (${label}) @smoke`, async ({ browser, context, page }) => {
    await residentSurface(context, variant.locale, variant.mode);
    let rideId = '';
    await test.step('[WP-013 rides/resident] submit structured access needs through the real UI', async () => {
      await page.goto('/rides');
      await assertResidentPresentation(page, variant.locale, variant.mode);
      const title = rideMessage(variant.locale, 'page.title');
      const disclaimer = rideMessage(variant.locale, 'page.disclaimer');
      const pickup = rideMessage(variant.locale, 'pickup.time');
      const wheelchair = rideMessage(variant.locale, 'accessibility.wheelchair');
      const initial = rideMessage(variant.locale, 'request.none');
      const sent = rideMessage(variant.locale, 'request.sent_unconfirmed');
      const send = rideMessage(variant.locale, 'request.send');
      const formLabels = [
        rideMessage(variant.locale, 'purpose.label'), rideMessage(variant.locale, 'mode.label'),
        rideMessage(variant.locale, 'pickup.place'), rideMessage(variant.locale, 'destination.label'),
        rideMessage(variant.locale, 'return.label'),
      ];
      for (const resolution of [title, disclaimer, pickup, wheelchair, initial, sent, send, ...formLabels]) {
        assertRideResolution(variant.locale, resolution);
      }
      const headingText = page.getByRole('heading', { name: title.text, exact: true }).getByText(title.text, { exact: true });
      await expect(headingText).toBeVisible();
      await expect(headingText).toHaveAttribute('lang', title.renderedLocale ?? '');
      const disclaimerText = page.getByText(disclaimer.text, { exact: true });
      await expect(disclaimerText).toBeVisible();
      await expect(disclaimerText).toHaveAttribute('lang', disclaimer.renderedLocale ?? '');
      if (title.affordance) {
        const titleAffordance = page.locator(
          `[data-catalog-affordance="${title.renderState}"][data-catalog-key="rides.page.title"]`,
        );
        await expect(titleAffordance).toHaveCount(1);
        await expect(titleAffordance).toHaveText(title.affordance);
      } else {
        await expect(page.locator('[data-catalog-affordance]')).toHaveCount(0);
      }
      for (const resolution of formLabels) {
        const label = page.locator('label').filter({
          has: page.locator(`[data-catalog-key="rides.${resolution.key}"]`).filter({ hasText: resolution.text }),
        });
        await expect(label).toHaveCount(1);
        await expect(label.locator('input, select')).toBeVisible();
      }
      const initialState = page.locator('[data-ride-initial-state]')
        .locator('[data-catalog-key="rides.request.none"]')
        .filter({ hasText: initial.text });
      await expect(initialState).toHaveCount(1);
      await expect(initialState).toHaveText(initial.text);
      await expect(initialState).toHaveAttribute('lang', initial.renderedLocale ?? '');
      await assertAssociatedAffordance(initialState, initial, 'WP-013 rides');
      await page.locator('#ride-pickup-at').fill('2027-01-20T08:30');
      await page.locator('input[name="accessibility"][value="wheelchair"]').check();
      const created = page.waitForResponse(response => response.url().endsWith('/api/v1/rides') && response.request().method() === 'POST');
      const sendButton = page.locator('[data-ride-request-form] button[type="submit"]');
      const sendText = sendButton.locator(
        `[data-catalog-key="rides.${send.key}"][data-catalog-render-state="${send.renderState}"]`,
      );
      await expect(sendText).toHaveCount(1);
      await expect(sendText).toHaveText(send.text);
      await assertAssociatedAffordance(sendText, send, 'WP-013 rides');
      await sendButton.click();
      const createdResponse = await created;
      expect(createdResponse.status(), '[WP-013 rides] public create route must persist the request').toBe(201);
      const ride = await createdResponse.json() as { id: string; state: string; accessibility_details: { code: string }[] };
      rideId = ride.id;
      expect(ride.state).toBe('waiting_for_dispatcher');
      expect(ride.accessibility_details).toEqual([{ code: 'wheelchair', label: wheelchair.text }]);
      const statusText = page.getByRole('status').getByText(sent.text, { exact: true });
      await expect(statusText).toBeVisible();
      await expect(statusText).toHaveAttribute('lang', sent.renderedLocale ?? '');
    });
    await test.step('[WP-013 rides/staff] staff sees the authoritative queue and cannot manufacture confirmation', async () => {
      const staff = await browser.newContext({ baseURL: WEB_URL });
      try {
        await roleContext(staff, STAFF_TOKEN);
        const queue = await staff.request.get('/api/v1/staff/rides');
        expect(queue.status()).toBe(200);
        const queueIds = (await queue.json() as { items: { id: string }[] }).items.map(item => item.id);
        expect(queueIds).toContain(rideId);
        expect(queueIds).not.toContain(foreign.ride);
        const fakeConfirmation = await staff.request.post(`/api/v1/rides/${rideId}/transitions`, {
          headers: { 'idempotency-key': `wp030-confirm-${variantIndex}` }, data: { to: 'confirmed_by', reason: 'staff cannot be provider evidence' },
        });
        expect(fakeConfirmation.status()).toBe(409);
        const final = await staff.request.post(`/api/v1/rides/${rideId}/transitions`, {
          headers: { 'idempotency-key': `wp030-unable-${variantIndex}` }, data: { to: 'unable_to_fulfill', reason: 'No authorized provider adapter' },
        });
        expect(final.status()).toBe(200);
        expect((await final.json() as { state: string }).state).toBe('unable_to_fulfill');
      } finally { await staff.close(); }
    });
    await test.step('[WP-004 auth/WP-013 rides] unauthenticated creation fails closed', async () => {
      const isolated = await browser.newContext({ baseURL: WEB_URL });
      try { expect((await isolated.request.post('/api/v1/rides', { data: {} })).status()).toBe(403); }
      finally { await isolated.close(); }
    });
    await test.step('[WP-013 rides → WP-009 print] authoritative ride appears in the resident schedule source', async () => {
      const response = await page.request.get('/api/v1/me/schedule/print?week_of=2027-01-18');
      expect(response.status(), '[WP-009 print] resident schedule source must be publicly readable').toBe(200);
      const snapshot = await response.json() as { source_version: string; items: Record<string, unknown>[] };
      const rideObservation = snapshot.items.find(item => JSON.stringify(item).includes(rideId));
      expect(rideObservation, `[WP-013 rides → WP-009 print] schedule must include created ride ${rideId}`).toBeDefined();
      const authoritativeDetails = JSON.stringify(rideObservation);
      expect(authoritativeDetails).toContain('unable_to_fulfill');
      expect(authoritativeDetails).toContain('2027-01-20');
      expect(authoritativeDetails).toContain('wheelchair');
      expect(rideObservation!.schedule_source, '[WP-009 print] item must identify the registered rides source').toBe('rides');
      expect(
        rideObservation!.schedule_source_version,
        '[WP-009 print] item must expose deterministic rides-source provenance',
      ).toMatch(/^rides:v1:[a-f0-9]{64}$/u);
      expect(snapshot.source_version, '[WP-009 print] aggregate must expose registered-source provenance')
        .toMatch(/^schedule:registered-sources:v1:[a-f0-9]{64}$/u);
    });
  });

  test(`[WP-014 assistance] resident priority request enters staff handling (${label}) @smoke`, async ({ browser, context, page }) => {
    await residentSurface(context, variant.locale, variant.mode);
    let requestId = '';
    await test.step('[WP-014 assistance/resident] submit priority assistance with emergency truth visible', async () => {
      await page.goto('/help');
      await assertResidentPresentation(page, variant.locale, variant.mode);
      const emergencyHeading = await assertAssistanceMessage(page, variant.locale, 'emergency.heading');
      await assertAssistanceMessage(page, variant.locale, 'emergency.disclaimer');
      const call911 = await assertAssistanceMessage(page, variant.locale, 'emergency.call_911');
      await assertAssistanceMessage(page, variant.locale, 'request.form_heading');
      await assertAssistanceMessage(page, variant.locale, 'request.details_label');
      await assertAssistanceMessage(page, variant.locale, 'request.unassigned_notice');
      const send = await assertAssistanceMessage(page, variant.locale, 'request.send');
      await expect(page.getByRole('heading', { name: new RegExp(emergencyHeading.text, 'iu') })).toBeVisible();
      await expect(page.getByRole('link', { name: new RegExp(call911.text, 'iu') })).toBeVisible();
      await page.locator('#assistance-summary').fill(variant.locale === 'es' ? 'Necesito ayuda con alimentos' : 'I need help with groceries');
      const created = page.waitForResponse(response => response.url().endsWith('/api/v1/assistance-requests') && response.request().method() === 'POST');
      await page.getByRole('button', { name: new RegExp(send.text, 'iu') }).click();
      const createdResponse = await created;
      expect(createdResponse.status(), '[WP-014 assistance] public create route must persist the request').toBe(201);
      const body = await createdResponse.json() as { id: string; state: string; triage_source: string; after_hours: boolean };
      requestId = body.id;
      expect(body).toMatchObject({ state: 'pending_unowned', triage_source: 'rules' });
      await assertAssistanceMessage(page, variant.locale, 'request.saved_heading');
      await assertAssistanceMessage(page, variant.locale, 'request.pending_state');
      await assertAssistanceMessage(page, variant.locale, body.after_hours ? 'request.after_hours' : 'request.normal_hours');
      await expect(page.getByRole('link', { name: new RegExp(call911.text, 'iu') }), '[WP-014 assistance] 911 guidance survives submission')
        .toBeVisible();
    });
    await test.step('[WP-014 assistance/staff-standard-boundary] authenticated staff owns the request via public HTTP', async () => {
      expect(variant.mode === 'easy' ? 'resident-easy/staff-standard' : 'resident-standard/staff-standard').toContain('staff-standard');
      const staff = await browser.newContext({ baseURL: WEB_URL });
      try {
        await roleContext(staff, STAFF_TOKEN);
        const queue = await staff.request.get('/api/v1/staff/assistance-requests');
        expect(queue.status()).toBe(200);
        const queueIds = (await queue.json() as { items: { id: string }[] }).items.map(item => item.id);
        expect(queueIds).toContain(requestId);
        expect(queueIds).not.toContain(foreign.assistance);
        const owned = await staff.request.post(`/api/v1/assistance-requests/${requestId}/transitions`, { data: { to: 'owned', owner_id: STAFF_ID, reason: 'Synthetic staff accepted the request' } });
        expect(owned.status()).toBe(200);
        expect(await owned.json()).toMatchObject({ id: requestId, state: 'owned', owner_id: STAFF_ID });
      } finally { await staff.close(); }
    });
    await test.step('[WP-004 auth/WP-014 assistance] resident cannot enter the staff queue', async () => {
      expect((await page.request.get('/api/v1/staff/assistance-requests')).status()).toBe(403);
    });
    await test.step('[WP-014 assistance → WP-006 audit] ownership is publicly observable as a request-specific audit fact', async () => {
      const admin = await browser.newContext({ baseURL: WEB_URL });
      try {
        await roleContext(admin, ADMIN_TOKEN);
        const target = `assistance_request:${requestId}`;
        const response = await admin.request.get(`/api/v1/admin/audit-events?action=assistance.owned&target=${encodeURIComponent(target)}`);
        expect(response.status(), '[WP-006 audit] authenticated admin route must expose the durable assistance audit').toBe(200);
        const audit = await response.json() as { items: { action?: string; target?: string; outcome?: string }[] };
        expect(audit.items, `[WP-014 assistance → WP-006 audit] request ${requestId} must have an ownership artifact`)
          .toContainEqual(expect.objectContaining({ action: 'assistance.owned', target, outcome: 'allowed' }));
      } finally { await admin.close(); }
    });
  });

  test(`[WP-017 caregiver → WP-013 authorization] itemized consent revokes immediately (${label}) @smoke`, async ({ browser, context, page }) => {
    await residentSurface(context, variant.locale, variant.mode);
    const caregiverLink = linkId(variantIndex);
    const ride = { resident_id: RESIDENT_ID, purpose: 'groceries', mode: 'partner_van', pickup_at: '2027-01-22T14:00:00.000Z', pickup_tz: 'America/New_York', pickup_location: 'home', destination_location: 'grocery_store', return_needed: false, accessibility_details: [] };
    const caregiver = await browser.newContext({ baseURL: WEB_URL });
    try {
      await roleContext(caregiver, caregiverToken(variantIndex));
      await test.step('[WP-017 caregiver/resident] save an exact, read-back-confirmed item list in the real UI', async () => {
        await page.goto('/caregiver');
        await assertResidentPresentation(page, variant.locale, variant.mode);
        const title = caregiverMessage(variant.locale, 'page.title');
        const intro = caregiverMessage(variant.locale, 'page.intro');
        const invitation = caregiverMessage(variant.locale, 'invitation.send');
        const link = caregiverMessage(variant.locale, 'consent.link_id');
        const viewSchedule = caregiverMessage(variant.locale, 'read_back.view_schedule');
        const bookRides = caregiverMessage(variant.locale, 'read_back.book_rides');
        const receiveAlerts = caregiverMessage(variant.locale, 'read_back.receive_alerts');
        const viewAssistance = caregiverMessage(variant.locale, 'read_back.view_assistance');
        const viewProfile = caregiverMessage(variant.locale, 'read_back.view_profile');
        const confirmation = caregiverMessage(variant.locale, 'consent.resident_confirmation');
        const save = caregiverMessage(variant.locale, 'consent.save');
        const saved = caregiverMessage(variant.locale, 'consent.permissions_saved');
        const boundaries = caregiverMessage(variant.locale, 'consent.boundaries');
        const titleHeading = page.getByRole('heading', { name: title.text });
        await expect(titleHeading).toBeVisible();
        await assertCaregiverRendering(titleHeading, title);
        await assertCaregiverRendering(
          page.locator('section[aria-labelledby="caregiver-title"] > div > p').first(), intro,
        );
        await expect(page.getByRole('button', { name: invitation.text })).toBeVisible();
        await page.getByLabel(link.text).fill(caregiverLink);
        await page.getByLabel(viewSchedule.text).check();
        await page.getByLabel(bookRides.text).check();
        await expect(page.getByLabel(receiveAlerts.text)).toBeVisible();
        await expect(page.getByLabel(viewAssistance.text)).toBeVisible();
        await expect(page.getByLabel(viewProfile.text)).toBeVisible();
        await page.getByLabel(confirmation.text).check();
        const permissionSaved = page.waitForResponse(response =>
          response.request().method() === 'PUT'
          && new URL(response.url()).pathname === `/api/v1/caregiver/links/${caregiverLink}/scopes`);
        await page.getByRole('button', { name: save.text }).click();
        expect((await permissionSaved).status()).toBe(200);
        const savedStatus = page.getByRole('main').getByRole('status');
        await assertCaregiverRendering(savedStatus, saved);
        await assertCaregiverRendering(page.locator('main p').filter({ hasText: boundaries.text }), boundaries);
      });
      await test.step('[WP-017 caregiver → WP-013 rides] granted caregiver may act only on the approved ride scope', async () => {
        const allowed = await caregiver.request.post('/api/v1/rides', { headers: { 'idempotency-key': `wp030-caregiver-before-${variantIndex}` }, data: ride });
        expect(allowed.status()).toBe(201);
      });
      await test.step('[WP-017 caregiver/revocation] resident revokes and the next caregiver action is denied', async () => {
        const staff = await browser.newContext({ baseURL: WEB_URL });
        try {
          await roleContext(staff, STAFF_TOKEN);
          const before = await staff.request.get('/api/v1/staff/rides');
          expect(before.status()).toBe(200);
          const beforeIds = (await before.json() as { items: { id: string }[] }).items.map(item => item.id);
          const residentBefore = await page.request.get('/api/v1/rides');
          expect(residentBefore.status()).toBe(200);
          const residentBeforeIds = (await residentBefore.json() as { items: { id: string }[] }).items.map(item => item.id);
          const revoke = caregiverMessage(variant.locale, 'consent.revoke');
          const revoked = caregiverMessage(variant.locale, 'consent.revoked');
          const revokedResponse = page.waitForResponse(response =>
            response.request().method() === 'DELETE'
            && new URL(response.url()).pathname === `/api/v1/caregiver/links/${caregiverLink}`);
          await page.getByRole('button', { name: revoke.text }).click();
          expect((await revokedResponse).status()).toBe(204);
          await assertCaregiverRendering(page.getByRole('main').getByRole('status'), revoked);
          const denied = await caregiver.request.post('/api/v1/rides', { headers: { 'idempotency-key': `wp030-caregiver-after-${variantIndex}` }, data: ride });
          expect(denied.status()).toBe(403);
          expect(await denied.json()).toEqual({ type: 'about:blank', title: 'Ride service unavailable', status: 403 });
          const after = await staff.request.get('/api/v1/staff/rides');
          expect(after.status()).toBe(200);
          const afterIds = (await after.json() as { items: { id: string }[] }).items.map(item => item.id);
          expect(afterIds).toEqual(beforeIds);
          const residentAfter = await page.request.get('/api/v1/rides');
          expect(residentAfter.status()).toBe(200);
          const residentAfterIds = (await residentAfter.json() as { items: { id: string }[] }).items.map(item => item.id);
          expect(residentAfterIds).toEqual(residentBeforeIds);
        } finally { await staff.close(); }
      });
      await test.step('[WP-004 auth/WP-017 caregiver] cross-tenant and wrong-role link access returns opaque 404', async () => {
        expect((await page.request.put(`/api/v1/caregiver/links/${foreign.caregiverLink}/scopes`, { data: { read_back_confirmed: true, scopes: [{ key: 'view_schedule', granted: true }] } })).status()).toBe(404);
        expect((await page.request.get('/api/v1/caregiver/links')).status()).toBe(404);
      });
    } finally { await caregiver.close(); }
  });

  test(`[WP-011 AI-off → WP-014 human continuity] native completion remains usable (${label}) @smoke`, async ({ browser, context, page }) => {
    await residentSurface(context, variant.locale, variant.mode);
    await test.step('[WP-011 concierge/AI-off] AI is truthfully absent while directory and human routes remain', async () => {
      await page.goto('/concierge');
      await assertResidentPresentation(page, variant.locale, variant.mode);
      const heading = serviceMessage(variant.locale, 'directory.heading');
      const start = serviceMessage(variant.locale, 'directory.help_link');
      await assertConciergeRendering(page.getByRole('heading', { name: heading.text }), heading);
      await assertConciergeRendering(page.getByRole('button', { name: start.text, exact: true }), start);
      const started = page.waitForResponse(response => response.url().endsWith('/api/v1/concierge/conversations') && response.request().method() === 'POST');
      await page.getByRole('button', { name: start.text, exact: true }).click();
      const startResponse = await started;
      expect(startResponse.status(), '[WP-011 concierge] AI-off start must accept an intentionally empty body').toBe(201);
      expect(await startResponse.json()).toMatchObject({ ai_enabled: false });
      await expect(page.getByRole('textbox')).toHaveCount(0);
      await assertConciergeHumanControls(page, variant.locale);
    });
    let handoffId = '';
    await test.step('[WP-014 assistance/human-path] explicit confirmation creates a real pending staff item', async () => {
      const confirm = commonMessage(variant.locale, 'confirm');
      const send = assistanceMessage(variant.locale, 'request.send');
      const saved = assistanceMessage(variant.locale, 'request.saved_heading');
      const pending = assistanceMessage(variant.locale, 'request.pending_state');
      await page.getByLabel(confirm.text).check();
      const response = page.waitForResponse(value => value.url().includes('/handoff') && value.request().method() === 'POST');
      await page.getByRole('button', { name: send.text }).click();
      const handoffResponse = await response;
      expect(handoffResponse.status(), '[WP-011 concierge → WP-014 assistance] empty handoff POST must reach the human path').toBe(201);
      const result = await handoffResponse.json() as { id: string; state: string };
      handoffId = result.id;
      expect(result.state).toBe('pending_unowned');
      const status = page.getByRole('main').getByRole('status');
      await expect(status).toContainText(saved.text);
      await expect(status).toContainText(pending.text);
    });
    await test.step('[WP-014 assistance/staff-standard-boundary] staff can see AI-off handoff without an Easy-only staff screen', async () => {
      const staff = await browser.newContext({ baseURL: WEB_URL });
      try {
        await roleContext(staff, STAFF_TOKEN);
        const queue = await staff.request.get('/api/v1/staff/assistance-requests');
        expect(queue.status()).toBe(200);
        expect((await queue.json() as { items: { id: string }[] }).items.map(item => item.id)).toContain(handoffId);
      } finally { await staff.close(); }
    });
    await test.step('[WP-004 auth/WP-011 concierge] missing and foreign sessions cannot start or disclose conversations', async () => {
      const anonymous = await browser.newContext({ baseURL: WEB_URL });
      const otherTenant = await browser.newContext({ baseURL: WEB_URL });
      try {
        await roleContext(otherTenant, FOREIGN_RESIDENT_TOKEN);
        expect((await anonymous.request.post('/api/v1/concierge/conversations')).status()).toBe(401);
        expect((await otherTenant.request.post('/api/v1/concierge/conversations')).status()).toBe(401);
      } finally { await anonymous.close(); await otherTenant.close(); }
    });
  });
}
