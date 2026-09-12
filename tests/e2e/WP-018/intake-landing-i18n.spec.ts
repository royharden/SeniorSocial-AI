import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import enIntake from '../../../packages/i18n/en/intake.json' with { type: 'json' };
import esIntake from '../../../packages/i18n/es/intake.json' with { type: 'json' };

const root = resolve(import.meta.dirname, '../../..');
const landingKeys = [
  'landing.title', 'landing.intro', 'landing.legal_heading', 'landing.legal_description',
  'landing.legal_start', 'landing.health_heading', 'landing.health_description',
  'disclaimer.health', 'landing.health_start',
] as const;

type EsbuildResult = { readonly outputFiles: ReadonlyArray<{ readonly path: string; readonly text: string }> };

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

async function landingHarness(): Promise<string> {
  const build = await loadInstalledEsbuild();
  const result = await build({
    stdin: {
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { flushSync } from 'react-dom';
        import { IntakeLanding } from './app/(shell)/intake/page.tsx';
        import enIntake from '../../packages/i18n/en/intake.json' with { type: 'json' };
        import esIntake from '../../packages/i18n/es/intake.json' with { type: 'json' };
        import { catalogSourceSha256, createCatalogResolver, resolveCatalogMessage } from '../../packages/i18n/src/catalogs.ts';

        const digest = catalogSourceSha256(enIntake);
        const sourceVersion = 'sha256:' + digest;
        const statuses = Object.fromEntries(Object.keys(enIntake).map(key => [
          'intake.' + key,
          {
            status: 'approved', source_version: sourceVersion, critical: key.startsWith('disclaimer.'),
            machine_generated: true, reviewed_by: 'fixture-reviewer',
            reviewer_qualification: 'qualified_spanish_reviewer', reviewed_at: '2026-09-11T12:00:00Z',
          },
        ]));
        const approved = createCatalogResolver({
          catalogs: { en: { intake: enIntake }, es: { intake: esIntake } },
          statuses: { intake: statuses },
          sourceBindings: { intake: { source_sha256: digest, source_version: sourceVersion } },
          criticalFallback: { renderState: 'held_english_fallback', affordance: 'available in English only' },
        });

        window.renderIntakeLanding = (mode) => {
          const locale = mode === 'english' ? 'en' : 'es';
          const resolveMessage = mode === 'approved' ? approved.resolve : resolveCatalogMessage;
          flushSync(() => createRoot(document.getElementById('root')).render(
            React.createElement(IntakeLanding, { locale, resolveMessage }),
          ));
        };
      `,
      resolveDir: resolve(root, 'apps/web'),
      loader: 'tsx',
    },
    bundle: true,
    // Next imports read build-time environment values even when the server page entry is tree-shaken.
    define: { 'process.env': '{}' },
    format: 'iife',
    jsx: 'automatic',
    logLevel: 'silent',
    platform: 'browser',
    plugins: [{
      name: 'intake-landing-css',
      setup(context: {
        onLoad(options: { filter: RegExp }, callback: (args: { path: string }) =>
          { contents: string; loader: string } | Promise<{ contents: string; loader: string }>): void;
      }) {
        // Exercise the real component without adding unsupported runtime exports to a Next page.
        context.onLoad({ filter: /[\\/]intake[\\/]page\.tsx$/ }, async ({ path }) => ({
          contents: `${await readFile(path, 'utf8')}\nexport { IntakeLanding };`,
          loader: 'tsx',
        }));
        context.onLoad({ filter: /intake\.module\.css$/ }, () => ({
          contents: 'export default { stack: "stack", choiceGrid: "choiceGrid", primaryLink: "primaryLink" };',
          loader: 'js',
        }));
      },
    }],
    treeShaking: true,
    write: false,
  });
  const output = result.outputFiles.find(file => file.path.endsWith('.js'))?.text ?? result.outputFiles[0]?.text;
  if (output === undefined) throw new Error('Intake landing browser harness was not generated');
  return output;
}

async function render(page: Page, mode: 'fallback' | 'approved' | 'english') {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: await landingHarness() });
  expect(errors, 'the actual intake component browser bundle must execute').toEqual([]);
  await page.evaluate(selected => (window as unknown as {
    renderIntakeLanding(value: string): void;
  }).renderIntakeLanding(selected), mode);
}

async function expectUnflaggedCopy(page: Page, locale: 'en' | 'es') {
  // what_bug_this_catches: untranslated or missing descriptions/buttons passing heading-only assertions,
  // or English text mislabeled as approved Spanish with stale fallback metadata.
  const catalog = locale === 'es' ? esIntake : enIntake;
  await expect(page.locator('[data-catalog-key]')).toHaveCount(landingKeys.length);
  for (const key of landingKeys) {
    const copy = page.locator(`[data-catalog-key="intake.${key}"]`);
    await expect(copy).toBeVisible();
    await expect(copy).toHaveText(catalog[key]);
    await expect(copy).toHaveAttribute('lang', locale);
    await expect(copy).toHaveAttribute('data-catalog-render-state', locale === 'es' ? 'approved_spanish' : 'english_source');
    await expect(copy).not.toHaveAttribute('data-catalog-fallback-reason');
    await expect(copy).not.toHaveAttribute('aria-describedby');
  }
  await expect(page.locator('[data-catalog-affordance]')).toHaveCount(0);
}

test.describe('WP-018/WP-032 intake landing resolver consumer', () => {
  test('held Spanish critical health copy renders governed English with its adjacent notice', async ({ page }) => {
    // what_bug_this_catches: the intake landing exposing draft Spanish medical copy or an unassociated fallback notice.
    await render(page, 'fallback');
    await expect(page.getByRole('heading', { name: 'Guided intake' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Ingreso guiado' })).toHaveCount(0);
    const disclaimer = page.locator('[data-catalog-key="intake.disclaimer.health"]');
    await expect(disclaimer).toHaveText('This form is not medical advice, diagnosis, treatment, or emergency care.');
    await expect(disclaimer).toHaveAttribute('lang', 'en');
    await expect(disclaimer).toHaveAttribute('data-catalog-render-state', 'held_english_fallback');
    await expect(disclaimer).toHaveAttribute('data-catalog-fallback-reason', 'critical_not_approved');
    await expect(page.getByText('Este formulario no constituye asesoría, diagnóstico, tratamiento ni atención médica de emergencia.')).toHaveCount(0);
    const describedBy = await disclaimer.getAttribute('aria-describedby');
    expect(describedBy).toBe('intake-disclaimer-health-translation-state');
    const notice = disclaimer.locator('xpath=../following-sibling::*[1]');
    await expect(notice).toHaveAttribute('id', describedBy!);
    await expect(notice).toHaveAttribute('lang', 'en');
    await expect(notice).toHaveAttribute('role', 'note');
    await expect(notice).toHaveAttribute('data-catalog-affordance', 'held_english_fallback');
    await expect(notice).toHaveText('available in English only');
    await expect(page.getByText('available in English only', { exact: true })).toHaveCount(1);
    await expect(page.getByRole('link', { name: 'Start legal services intake' })).toHaveAttribute('href', '/intake/legal');
    await expect(page.getByRole('link', { name: 'Start community health intake' })).toHaveAttribute('href', '/intake/health');
    await expect(page.getByText(/eligib/iu)).toHaveCount(0);
  });

  test('approved Spanish and English source copy carry truthful lang metadata without false notices', async ({ page }) => {
    // what_bug_this_catches: approved/source copy retaining a held notice or being labeled with the wrong language.
    await render(page, 'approved');
    await expectUnflaggedCopy(page, 'es');
    await expect(page.getByRole('heading', { name: 'Ingreso guiado' }).locator('[lang="es"]')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Ingreso para servicios legales' }).locator('[lang="es"]')).toBeVisible();
    await expect(page.locator('[data-catalog-key="intake.disclaimer.health"]')).toHaveAttribute('lang', 'es');
    await expect(page.locator('[data-catalog-affordance]')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Comenzar el ingreso para servicios legales' })).toHaveAttribute('href', '/intake/legal');
    await expect(page.getByRole('link', { name: 'Comenzar el ingreso para salud comunitaria' })).toHaveAttribute('href', '/intake/health');

    await render(page, 'english');
    await expectUnflaggedCopy(page, 'en');
    await expect(page.getByRole('heading', { name: 'Guided intake' }).locator('[lang="en"]')).toBeVisible();
    await expect(page.locator('[data-catalog-key="intake.disclaimer.health"]')).toHaveAttribute('lang', 'en');
    await expect(page.locator('[data-catalog-affordance]')).toHaveCount(0);
  });
});
