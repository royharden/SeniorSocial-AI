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

async function workbenchHarness(): Promise<string> {
  const build = await loadInstalledEsbuild();
  const result = await build({
    stdin: {
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import TranslationWorkbench from './app/translate/workbench.tsx';
        import enTranslate from '../../packages/i18n/en/translate.json' with { type: 'json' };
        import esTranslate from '../../packages/i18n/es/translate.json' with { type: 'json' };
        import { catalogSourceSha256, createCatalogResolver, resolveCatalogMessage } from '../../packages/i18n/src/catalogs.ts';

        const digest = catalogSourceSha256(enTranslate);
        const sourceVersion = 'sha256:' + digest;
        const statuses = Object.fromEntries(Object.keys(enTranslate).map(key => [
          'translate.' + key,
          {
            status: 'approved', source_version: sourceVersion, critical: false, machine_generated: true,
            reviewed_by: 'synthetic-reviewer', reviewer_qualification: 'qualified_spanish_reviewer',
            reviewed_at: '2026-09-11T12:00:00Z',
          },
        ]));
        const approved = createCatalogResolver({
          catalogs: { en: { translate: enTranslate }, es: { translate: esTranslate } },
          statuses: { translate: statuses },
          sourceBindings: { translate: { source_sha256: digest, source_version: sourceVersion } },
          criticalFallback: { renderState: 'held_english_fallback', affordance: 'available in English only' },
        });
        const fixture = { items: [{
          source: {
            id: '11111111-1111-4111-8111-111111111111', orgId: '22222222-2222-4222-8222-222222222222',
            key: 'sample.notice', text: 'The office opens at 9:00.', hash: 'a'.repeat(64), version: 1,
            critical: false, updatedAt: '2026-09-11T12:00:00Z',
          },
          history: [{
            id: '33333333-3333-4333-8333-333333333333', orgId: '22222222-2222-4222-8222-222222222222',
            sourceId: '11111111-1111-4111-8111-111111111111', sourceHash: 'a'.repeat(64), sourceVersion: 1,
            text: 'La oficina abre a las 9:00.', provenance: 'manual', machineGenerated: false, aiEventId: null,
            status: 'draft', createdBy: '44444444-4444-4444-8444-444444444444', createdAt: '2026-09-11T12:00:00Z',
            reviewedBy: null, reviewerQualification: null, reviewerNote: null, reviewedAt: null,
            publishedBy: null, publishedAt: null, publishable: false,
          }],
        }] };
        window.fetch = async () => new Response(JSON.stringify(fixture), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
        window.renderWorkbench = mode => createRoot(document.getElementById('root')).render(
          React.createElement(TranslationWorkbench, {
            locale: 'es', resolveMessage: mode === 'approved' ? approved.resolve : resolveCatalogMessage,
          }),
        );
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
  if (output === undefined) throw new Error('Workbench browser harness was not generated');
  return output;
}

test.describe('WP-032 translation workbench resolver boundary', () => {
  test('shipped provisional copy falls back with an accessible affordance in the real browser component', async ({ page }) => {
    // what_bug_this_catches: the workbench importing provisional Spanish directly instead of honoring resolver review state.
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: await workbenchHarness() });
    await page.evaluate(() => (window as unknown as { renderWorkbench(mode: string): void }).renderWorkbench('fallback'));
    await page.waitForTimeout(100);
    expect(pageErrors).toEqual([]);
    await expect(page.getByRole('heading', { name: 'Spanish translation review' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'sample.notice' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Revisión de la traducción al español' })).toHaveCount(0);
    const messages = page.locator('[data-i18n-key]');
    const affordances = page.locator('[data-i18n-affordance]');
    await expect(messages.first()).toHaveAttribute('data-render-state', 'provisional_english_fallback');
    expect(await messages.count()).toBeGreaterThan(10);
    expect(await affordances.count()).toBeLessThan(await messages.count());
    await expect(affordances.first()).toHaveAttribute('role', 'note');
    await expect(affordances.first()).toHaveText('Spanish translation is awaiting review.');
    await expect(page.getByRole('textbox', { name: 'English source text' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Select a source' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Manual draft', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Machine-assisted draft', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Publish', exact: true })).toBeVisible();
    await expect(page.getByText('Draft', { exact: true })).toBeVisible();
    await expect(page.locator('button [data-i18n-affordance], select [data-i18n-affordance], input [data-i18n-affordance], textarea [data-i18n-affordance]')).toHaveCount(0);
    const controls = page.locator('button, select, input, textarea');
    expect(await controls.count()).toBeGreaterThan(8);
    for (let index = 0; index < await controls.count(); index += 1) {
      const describedBy = await controls.nth(index).getAttribute('aria-describedby');
      expect(describedBy).toBeTruthy();
      for (const id of describedBy?.split(/\s+/u) ?? []) await expect(page.locator(`#${id}`)).toBeVisible();
    }
    for (let index = 0; index < await messages.count(); index += 1) {
      const describedBy = await messages.nth(index).getAttribute('aria-describedby');
      expect(describedBy).toBeTruthy();
      for (const id of describedBy?.split(/\s+/u) ?? []) await expect(page.locator(`#${id}`)).toBeVisible();
    }
  });

  test('qualified synthetic approval renders Spanish and removes fallback affordances', async ({ page }) => {
    // what_bug_this_catches: the workbench remaining hardcoded to English after the shared resolver authorizes Spanish.
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: await workbenchHarness() });
    await page.evaluate(() => (window as unknown as { renderWorkbench(mode: string): void }).renderWorkbench('approved'));
    await expect(page.getByRole('heading', { name: 'Revisión de la traducción al español' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'sample.notice' })).toBeVisible();
    await expect(page.locator('[data-render-state="approved_spanish"][lang="es"]').first()).toBeVisible();
    await expect(page.locator('[data-i18n-affordance]')).toHaveCount(0);
    await expect(page.locator('button[aria-describedby], select[aria-describedby], input[aria-describedby], textarea[aria-describedby]')).toHaveCount(0);
  });
});
