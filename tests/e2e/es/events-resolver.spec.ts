import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';

const root = resolve(import.meta.dirname, '../../..');

type EsbuildResult = { readonly outputFiles: ReadonlyArray<{ readonly text: string }> };

async function loadInstalledEsbuild(): Promise<(options: Record<string, unknown>) => Promise<EsbuildResult>> {
  const virtualStore = resolve(root, 'node_modules/.pnpm');
  const versions = (await readdir(virtualStore)).filter(name => name.startsWith('esbuild@')).sort().reverse();
  const selected = versions[0];
  if (selected === undefined) throw new Error('Installed esbuild package not found');
  const entry = resolve(virtualStore, selected, 'node_modules/esbuild/lib/main.js');
  const loaded = await import(pathToFileURL(entry).href) as {
    build?: (options: Record<string, unknown>) => Promise<EsbuildResult>;
  };
  if (typeof loaded.build !== 'function') throw new Error('Installed esbuild build API not found');
  return loaded.build;
}

async function eventsHarness(): Promise<string> {
  const build = await loadInstalledEsbuild();
  const result = await build({
    stdin: {
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { flushSync } from 'react-dom';
        import { EventsContent } from './app/(shell)/events/page.tsx';
        import enEvents from '../../packages/i18n/en/events.json' with { type: 'json' };
        import esEvents from '../../packages/i18n/es/events.json' with { type: 'json' };
        import { catalogSourceSha256, createCatalogResolver, resolveCatalogMessage } from '../../packages/i18n/src/catalogs.ts';

        const digest = catalogSourceSha256(enEvents);
        const sourceVersion = 'sha256:' + digest;
        const statuses = Object.fromEntries(Object.keys(enEvents).map(key => [
          'events.' + key,
          {
            status: 'approved', source_version: sourceVersion, critical: false, machine_generated: true,
            reviewed_by: 'synthetic-reviewer', reviewer_qualification: 'qualified_spanish_reviewer',
            reviewed_at: '2026-09-11T12:00:00Z',
          },
        ]));
        const approved = createCatalogResolver({
          catalogs: { en: { events: enEvents }, es: { events: esEvents } },
          statuses: { events: statuses },
          sourceBindings: { events: { source_sha256: digest, source_version: sourceVersion } },
          criticalFallback: { renderState: 'held_english_fallback', affordance: 'available in English only' },
        });
        const fullId = '11111111-1111-4111-8111-111111111111';
        const openId = '22222222-2222-4222-8222-222222222222';
        const fixture = {
          items: [
            { id: fullId, title: 'Full lunch', starts_at: '2026-09-20T16:00:00.000Z', time_zone: 'America/New_York',
              location: 'Civic Hall', capacity: 4, rsvp_count: 4, accessibility: ['step-free'] },
            { id: openId, title: 'Open workshop', starts_at: '2026-09-21T16:00:00.000Z', time_zone: 'America/New_York',
              location: 'Library', capacity: 10, rsvp_count: 3, accessibility: [] },
          ],
          reasons: { [fullId]: 'Near your home', [openId]: 'Matches your interests' },
        };
        window.proposalFails = false;
        window.lastProposal = null;
        window.listMode = 'success';
        window.deferNextLoad = false;
        window.resolveDeferredLoad = null;
        window.fetch = async (input, init = {}) => {
          const url = String(input);
          if (url.endsWith('/api/v1/recommendations/events')) {
            if (window.deferNextLoad || window.listMode === 'deferred') {
              window.deferNextLoad = false;
              window.listMode = 'success';
              return new Promise(resolve => { window.resolveDeferredLoad = () => {
                window.resolveDeferredLoad = null;
                resolve(new Response(JSON.stringify(fixture), {
                  status: 200, headers: { 'content-type': 'application/json' },
                }));
              }; });
            }
            if (window.listMode === 'unauthorized') return new Response('{}', { status: 401 });
            if (window.listMode === 'server') return new Response('{}', { status: 500 });
            if (window.listMode === 'network') throw new Error('synthetic network failure');
            if (window.listMode === 'empty') return new Response(JSON.stringify({ items: [] }), {
              status: 200, headers: { 'content-type': 'application/json' },
            });
            return new Response(JSON.stringify(fixture), {
              status: 200, headers: { 'content-type': 'application/json' },
            });
          }
          if (url.endsWith('/api/v1/event-proposals')) {
            window.lastProposal = JSON.parse(String(init.body));
            return new Response('{}', { status: window.proposalFails ? 500 : 201 });
          }
          if (url.includes(fullId) && url.endsWith('/rsvp') && init.method === 'POST') return new Response('{}', { status: 409 });
          return new Response('{}', { status: 201 });
        };
        window.renderEvents = (mode, listMode = 'success') => {
          window.listMode = listMode;
          flushSync(() => createRoot(document.getElementById('root')).render(
            React.createElement(EventsContent, {
              resolveMessage: mode === 'approved' ? approved.resolve : resolveCatalogMessage,
            }),
          ));
          window.localizedMessagesAtInitialCommit = document.querySelectorAll('[data-i18n-key]').length;
        };
      `,
      resolveDir: resolve(root, 'apps/web'),
      loader: 'tsx',
    },
    bundle: true,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    write: false,
    logLevel: 'silent',
  });
  const output = result.outputFiles[0]?.text;
  if (output === undefined) throw new Error('Events browser harness was not generated');
  return output;
}

async function render(
  page: import('@playwright/test').Page,
  mode: 'fallback' | 'approved',
  listMode: 'success' | 'unauthorized' | 'server' | 'network' | 'empty' | 'deferred' = 'success',
) {
  await page.setContent('<div class="ss-app" data-locale="es"><div id="root"></div></div>');
  await page.addScriptTag({ content: await eventsHarness() });
  await page.evaluate(({ selected, selectedListMode }) => (window as unknown as {
    renderEvents(mode: string, loadMode: string): void;
  }).renderEvents(selected, selectedListMode), { selected: mode, selectedListMode: listMode });
  expect(await page.evaluate(() => (window as unknown as { localizedMessagesAtInitialCommit: number }).localizedMessagesAtInitialCommit)).toBe(0);
  await expect(page.getByRole('heading', { name: mode === 'approved' ? 'Eventos' : 'Events' })).toBeVisible();
  if (listMode === 'success') await expect(page.getByRole('heading', { name: 'Full lunch' })).toBeVisible();
}

test.describe('WP-032 events approval-aware consumer', () => {
  test('production Spanish request uses provisional English with associated external affordances and preserves workflows', async ({ page }) => {
    // what_bug_this_catches: draft Spanish bypassing review, inaccessible notices inside controls, or localization breaking event actions.
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await render(page, 'fallback');
    expect(pageErrors).toEqual([]);
    await expect(page.getByRole('heading', { name: 'Eventos' })).toHaveCount(0);
    await expect(page.getByRole('status')).toContainText('Machine recommendations are off');
    await expect(page.getByText('This event is full.', { exact: true })).toBeVisible();
    await expect(page.getByText('A waitlist is available.', { exact: true })).toBeVisible();
    await expect(page.getByText('7 spaces available', { exact: true })).toBeVisible();
    await expect(page.getByText('{count} spaces available', { exact: true })).toHaveCount(0);
    const affordances = page.locator('[data-i18n-affordance]');
    expect(await affordances.count()).toBeGreaterThan(0);
    await expect(affordances.first()).toHaveText('Spanish translation is awaiting review.');
    await expect(page.locator('button [data-i18n-affordance], select [data-i18n-affordance], input [data-i18n-affordance], textarea [data-i18n-affordance]')).toHaveCount(0);
    const controls = page.locator('button, select, input, textarea');
    for (let index = 0; index < await controls.count(); index += 1) {
      const describedBy = await controls.nth(index).getAttribute('aria-describedby');
      expect(describedBy).toBeTruthy();
      for (const id of describedBy?.split(/\s+/u) ?? []) await expect(page.locator(`#${id}`)).toBeVisible();
    }
    for (let index = 0; index < await affordances.count(); index += 1) {
      const id = await affordances.nth(index).getAttribute('id');
      expect(id).toBeTruthy();
      expect(await page.locator(`[aria-describedby~="${id}"]`).count()).toBeGreaterThan(0);
    }

    await page.getByRole('button', { name: 'Attend this event', exact: true }).first().click();
    await expect(page.getByRole('status')).toContainText('This event is full.');
    await expect(page.getByRole('status')).toContainText('A waitlist is available.');
    await page.getByRole('button', { name: 'Join the waitlist', exact: true }).first().click();
    await expect(page.getByRole('status')).toContainText('On the waitlist');
    await page.getByRole('button', { name: 'Attend this event', exact: true }).nth(1).click();
    await expect(page.getByRole('status')).toContainText('You are marked as attending.');
    await expect(page.getByRole('status')).toContainText('Check the event details again before you go.');
    await page.getByRole('button', { name: 'Cancel attendance', exact: true }).nth(1).click();
    await expect(page.getByRole('status')).toContainText('Your attendance was cancelled.');

    await page.getByLabel('Event title').fill('Chess afternoon');
    await page.getByLabel('Date and time').fill('');
    await page.locator('form').last().evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await expect(page.getByRole('status')).toContainText('Enter a valid future date and time.');
    await page.getByLabel('Date and time').fill('2026-09-21T18:00');
    await page.getByLabel('Why would this event help the community?').fill('Beginner tables welcome');
    await page.getByRole('button', { name: 'Send suggestion', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Suggestion sent for staff review. It is not published yet.');
    await expect.poll(() => page.evaluate(() => (window as unknown as { lastProposal: unknown }).lastProposal)).toMatchObject({
      title: 'Chess afternoon', time_zone: 'America/New_York', note: 'Beginner tables welcome',
    });
    await expect(page.getByLabel('Event title')).toHaveValue('');
    await page.evaluate(() => { (window as unknown as { proposalFails: boolean }).proposalFails = true; });
    await page.getByLabel('Event title').fill('Another event');
    await page.getByLabel('Date and time').fill('2026-09-22T18:00');
    await page.getByRole('button', { name: 'Send suggestion', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('The event suggestion could not be saved.');
  });

  test('qualified synthetic approval renders Spanish without changing shipped review metadata', async ({ page }) => {
    // what_bug_this_catches: the consumer hardcoding English after the resolver authorizes qualified Spanish.
    await render(page, 'approved');
    await expect(page.getByRole('button', { name: 'Asistir a este evento', exact: true }).first()).toBeVisible();
    await expect(page.getByText('Hay 7 lugares disponibles', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Sugerir un evento' })).toBeVisible();
    await expect(page.locator('[data-render-state="approved_spanish"][lang="es"]').first()).toBeVisible();
    await expect(page.locator('[data-i18n-affordance]')).toHaveCount(0);
    await expect(page.locator('button[aria-describedby], select[aria-describedby], input[aria-describedby], textarea[aria-describedby]')).toHaveCount(0);
  });

  test('distinguishes authentication, load failures, and a successful empty list', async ({ page }) => {
    // what_bug_this_catches: authentication, failed loads, and valid empty results collapsing into one misleading state.
    await render(page, 'fallback', 'unauthorized');
    await expect(page.getByRole('status')).toContainText('Sign in to view events.');
    await render(page, 'fallback', 'server');
    await expect(page.getByRole('status')).toContainText('Events could not be loaded. Try again.');
    await render(page, 'fallback', 'network');
    await expect(page.getByRole('status')).toContainText('Events could not be loaded. Try again.');
    await render(page, 'fallback', 'empty');
    await expect(page.getByRole('status')).toContainText('No events are available right now.');
  });

  test('deferred list loads cannot overwrite proposal or post-action feedback', async ({ page }) => {
    // what_bug_this_catches: a slower initial or refresh GET replacing newer interaction feedback with the list-state message.
    await render(page, 'fallback', 'deferred');
    await page.getByLabel('Event title').fill('Chess afternoon');
    await page.getByLabel('Date and time').fill('2026-09-21T18:00');
    await page.getByLabel('Why would this event help the community?').fill('Beginner tables welcome');
    await page.getByRole('button', { name: 'Send suggestion', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Suggestion sent for staff review. It is not published yet.');
    await expect.poll(() => page.evaluate(() => typeof (window as unknown as { resolveDeferredLoad: unknown }).resolveDeferredLoad)).toBe('function');
    await page.evaluate(() => (window as unknown as { resolveDeferredLoad(): void }).resolveDeferredLoad());
    await expect(page.getByRole('heading', { name: 'Open workshop' })).toBeVisible();
    await expect(page.getByRole('status')).toContainText('Suggestion sent for staff review. It is not published yet.');

    await page.evaluate(() => { (window as unknown as { deferNextLoad: boolean }).deferNextLoad = true; });
    await page.getByRole('button', { name: 'Attend this event', exact: true }).nth(1).click();
    await expect.poll(() => page.evaluate(() => typeof (window as unknown as { resolveDeferredLoad: unknown }).resolveDeferredLoad)).toBe('function');
    await page.evaluate(() => (window as unknown as { resolveDeferredLoad(): void }).resolveDeferredLoad());
    await expect(page.getByRole('status')).toContainText('You are marked as attending.');
    await expect(page.getByRole('status')).toContainText('Check the event details again before you go.');
  });
});
