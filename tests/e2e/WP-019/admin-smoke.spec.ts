import { expect, test, type Page, type Route } from '@playwright/test';

const orgId = '10000000-0000-4000-8000-000000000019';
const userId = '20000000-0000-4000-8000-000000000019';
const sourceId = '50000000-0000-4000-8000-000000000019';
const draftId = '60000000-0000-4000-8000-000000000019';

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

function applicationOrigin(baseURL: string | undefined): string {
  if (!baseURL) throw new Error('The admin smoke requires Playwright use.baseURL');
  const configured = new URL(baseURL);
  if (configured.hostname === '127.0.0.1' || configured.hostname === '[::1]') configured.hostname = 'localhost';
  return configured.origin;
}

function translationFixture({
  createdAt = '2026-09-11T12:30:00Z', draftVersion = 1, sourceVersion = 1,
}: { readonly createdAt?: string; readonly draftVersion?: unknown; readonly sourceVersion?: unknown } = {}) {
  return { items: [{
    source: { id: sourceId, key: 'home.title', version: sourceVersion },
    history: [{
      id: draftId, sourceId, sourceVersion: draftVersion, status: 'awaiting_review',
      createdBy: userId, createdAt,
    }],
  }] };
}

async function installApi(page: Page) {
  let held = true;
  const mutations: Array<{ headers: Record<string, string>; method: string; payload: unknown; url: string }> = [];
  await page.route('**/api/v1/**', async route => {
    const request = route.request();
    const url = request.url();
    if (request.method() === 'PATCH' && url.endsWith(`/admin/users/${userId}`)) {
      const payload = request.postDataJSON() as { account_state: string };
      held = payload.account_state === 'held_for_review';
      mutations.push({ headers: request.headers(), method: request.method(), payload, url });
      return json(route, { id: userId });
    }
    if (request.method() === 'POST' && /\/admin\/(content-pages|faqs|announcements|partners)$/u.test(url)) {
      const payload = request.postDataJSON() as Record<string, unknown>;
      mutations.push({ headers: request.headers(), method: request.method(), payload, url });
      return json(route, { id: crypto.randomUUID(), ...payload });
    }
    let body: unknown = { items: [], meta: { next_cursor: null, total_known: true } };
    if (url.includes('/staff/assistance-requests')) body = { items: [
      { id: '30000000-0000-4000-8000-000000000019', org_id: orgId, state: 'pending_unowned', triage_category: 'food' },
      { id: '30000000-0000-4000-8000-000000000020', org_id: orgId, state: 'owned', triage_category: 'custom_referral', owner_id: userId },
    ], meta: { next_cursor: null, total_known: true } };
    else if (url.includes('/staff/moderation-queue')) body = { items: [{ id: '40000000-0000-4000-8000-000000000019', source: 'user_report', target_type: 'message', decision: null, decided_by: null }], meta: { next_cursor: null, total_known: true } };
    else if (url.includes('/admin/translations')) body = { items: [{
      source: {
        id: sourceId, orgId, key: 'home.title', text: 'Home', hash: 'a'.repeat(64), version: 3,
        critical: false, updatedAt: '2026-09-11T12:00:00Z',
      },
      history: [
        {
          id: draftId, orgId, sourceId, sourceHash: 'a'.repeat(64), sourceVersion: 3,
          text: 'Inicio', provenance: 'manual', machineGenerated: false, aiEventId: null,
          status: 'awaiting_review', createdBy: userId, createdAt: '2026-09-11T12:30:00Z',
          reviewedBy: null, reviewerQualification: null, reviewerNote: null, reviewedAt: null,
          publishedBy: null, publishedAt: null, publishable: false,
        },
        {
          id: '60000000-0000-4000-8000-000000000020', orgId, sourceId,
          sourceHash: 'a'.repeat(64), sourceVersion: 2, status: 'invalidated',
          createdBy: userId, createdAt: '2026-09-10T12:30:00Z',
        },
      ],
    }] };
    else if (url.endsWith('/admin/users')) body = { items: [{ id: userId, display_name: 'Ana', roles: ['senior', 'custom_role'], account_state: held ? 'held_for_review' : 'active', version: 7 }], meta: { next_cursor: null, total_known: true } };
    else if (url.endsWith('/admin/content-pages')) body = { items: [{ id: 'page-1', slug: 'ayuda', version: 1, critical: false }], meta: { next_cursor: null, total_known: true } };
    else if (url.endsWith('/admin/analytics')) body = { as_of: '2026-09-11T00:00:00Z', source_version: 'wp-019-test', tiles: [
      { key: 'users', value: 11, unit_definition: 'Stored rows.', known_gap: 'Small groups suppressed.' },
      { key: 'custom_metric', value: 3, unit_definition: 'Partner supplied.', known_gap: null },
    ] };
    return json(route, body);
  });
  return mutations;
}

async function expectNoticesAssociated(page: Page) {
  const notices = page.locator('[data-admin-locale] [data-catalog-affordance]');
  expect(await notices.count()).toBeGreaterThan(0);
  for (let index = 0; index < await notices.count(); index += 1) {
    const id = await notices.nth(index).getAttribute('id');
    expect(id).toBeTruthy();
    await expect(page.locator(`[aria-describedby~="${id}"]`)).not.toHaveCount(0);
  }
  await expect(page.locator('button [data-catalog-affordance], input [data-catalog-affordance]')).toHaveCount(0);
}

test('shell Spanish renders governed fallback, critical holds, and exact dynamic data', async ({ baseURL, context, page }) => {
  // what_bug_this_catches: a private locale toggle or raw Spanish dictionary bypassing approval state on staff controls.
  const origin = applicationOrigin(baseURL);
  const mutations = await installApi(page);
  await context.addCookies([{ name: 'seniorsocial.locale.v1', value: 'es', url: origin }]);
  const translationRequest = page.waitForRequest(request => new URL(request.url()).pathname === '/api/v1/admin/translations');
  await page.goto(`${origin}/admin`);
  expect(new URL((await translationRequest).url()).searchParams.get('status')).toBe('awaiting_review');
  await expect(page.locator('[data-admin-locale="es"]')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Staff dashboard' })).toBeVisible();
  await expect(page.locator('[data-admin-locale="es"]').getByRole('button', { name: 'Español' })).toHaveCount(0);
  await expect(page.getByText('Panel del personal', { exact: true })).toHaveCount(0);
  await expect(page.locator('[data-catalog-key="admin.page.title"]')).toHaveAttribute('lang', 'en');
  await expect(page.locator('[data-catalog-key="admin.page.title"]')).toHaveAttribute('data-catalog-render-state', 'provisional_english_fallback');
  await expect(page.getByRole('heading', { name: 'Moderation' }).locator('[data-catalog-render-state="held_english_fallback"]')).toBeVisible();
  await expect(page.locator('[data-catalog-key="admin.state.held_for_review"][data-catalog-render-state="held_english_fallback"]')).toHaveText('Held for review');
  const release = page.getByRole('button', { name: 'Release hold' });
  await expect(release).toHaveAttribute('aria-describedby', /admin-users-translation-/u);
  await expect(page.getByText('Food support', { exact: true })).toBeVisible();
  await expect(page.getByText('custom_referral', { exact: true })).toHaveAttribute('data-admin-unknown-value', '');
  await expect(page.getByText('custom_role', { exact: true })).toHaveAttribute('data-admin-unknown-value', '');
  await expect(page.getByText('custom_metric', { exact: true })).toHaveAttribute('data-admin-unknown-value', '');
  await expect(page.getByText('Stored rows. Small groups suppressed.', { exact: true })).toBeVisible();
  const translationQueue = page.locator('section[aria-labelledby="queue-translation"]');
  await expect(translationQueue.getByText('home.title', { exact: true })).toHaveAttribute('data-admin-unknown-value', '');
  await expect(translationQueue.getByText('Awaiting review', { exact: true })).toBeVisible();
  await expect(translationQueue.getByText('Invalidated', { exact: true })).toHaveCount(0);
  await expect(translationQueue.getByText('Could not load this section.', { exact: true })).toHaveCount(0);
  await expectNoticesAssociated(page);

  await release.click();
  await expect(page.getByRole('button', { name: 'Hold for review' })).toBeVisible();
  expect(mutations[0]).toMatchObject({ method: 'PATCH', payload: { account_state: 'active', expected_version: 7 } });

  const announcement = page.getByRole('heading', { name: 'Announcement' }).locator('..');
  await announcement.locator('input[name="title"]').fill('Road closure');
  await announcement.locator('input[name="publish_at"]').fill('2026-09-12T09:30');
  await announcement.getByRole('button', { name: 'Create' }).click();
  await expect.poll(() => mutations.length).toBe(2);
  expect(mutations[1]?.payload).toEqual({ title: 'Road closure', publish_at: new Date('2026-09-12T09:30').toISOString() });
  expect(mutations[1]?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/u);
});

test('queue failures and successful empty responses remain distinct governed states', async ({ baseURL, page }) => {
  // what_bug_this_catches: malformed translation history or coercible versions being presented as a truthful empty queue.
  const origin = applicationOrigin(baseURL);
  let translationPayload: unknown = { items: [] };
  await page.route('**/api/v1/**', route => {
    const url = route.request().url();
    if (url.includes('/staff/assistance-requests')) return json(route, {}, 500);
    if (url.includes('/admin/translations')) return json(route, translationPayload);
    return json(route, url.endsWith('/admin/analytics')
      ? { as_of: '2026-09-11T00:00:00Z', source_version: 'test', tiles: [] }
      : { items: [], meta: { next_cursor: null, total_known: true } });
  });
  await page.goto(`${origin}/admin`);
  const assistance = page.locator('section[aria-labelledby="queue-assistance"]');
  await expect(assistance.getByRole('alert')).toContainText('Could not load this section.');
  const rides = page.locator('section[aria-labelledby="queue-rides"]');
  await expect(rides.getByText('Nothing needs attention.', { exact: true })).toBeVisible();
  const translations = page.locator('section[aria-labelledby="queue-translation"]');
  await expect(translations.getByText('Nothing needs attention.', { exact: true })).toBeVisible();
  await expect(translations.getByRole('alert')).toHaveCount(0);

  const malformed = [
    { name: 'string source version', payload: translationFixture({ sourceVersion: '1' }) },
    { name: 'boolean draft version', payload: translationFixture({ draftVersion: true }) },
    { name: 'stale awaiting-review version', payload: translationFixture({ sourceVersion: 2, draftVersion: 1 }) },
    { name: 'impossible calendar date', payload: translationFixture({ createdAt: '2026-02-30T12:30:00Z' }) },
    { name: 'malformed skipped status', payload: { items: [{
      source: { id: sourceId, key: 'home.title', version: 1 }, history: [{ status: 'invalidated' }],
    }] } },
  ];
  for (const scenario of malformed) {
    translationPayload = scenario.payload;
    await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/admin/translations'),
      page.reload(),
    ]);
    await expect(translations.getByRole('alert'), scenario.name).toContainText('Could not load this section.');
    await expect(translations.getByText('Nothing needs attention.', { exact: true }), scenario.name).toHaveCount(0);
  }
});
