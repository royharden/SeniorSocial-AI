import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';

const root = resolve(import.meta.dirname, '../../..');

async function harness() {
  const store = resolve(root, 'node_modules/.pnpm');
  const version = (await readdir(store)).filter(name => name.startsWith('esbuild@')).sort().reverse()[0];
  if (!version) throw new Error('Installed esbuild package not found');
  const esbuild = await import(pathToFileURL(resolve(store, version, 'node_modules/esbuild/lib/main.js')).href) as {
    build(options: Record<string, unknown>): Promise<{ outputFiles: Array<{ text: string }> }>;
  };
  const result = await esbuild.build({
    stdin: { contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client'; import {flushSync} from 'react-dom';
      import {SettingsContent} from './app/(shell)/settings/page.tsx';
      import {ConfirmPreferenceContent} from './app/(shell)/preferences/confirm/page.tsx';
      import enProfile from '../../packages/i18n/en/profile.json' with {type:'json'};
      import esProfile from '../../packages/i18n/es/profile.json' with {type:'json'};
      import enCommon from '../../packages/i18n/en/common.json' with {type:'json'};
      import esCommon from '../../packages/i18n/es/common.json' with {type:'json'};
      import {catalogSourceSha256,createCatalogResolver,resolveCatalogMessage} from '../../packages/i18n/src/catalogs.ts';
      const catalogs={en:{profile:enProfile,common:enCommon},es:{profile:esProfile,common:esCommon}};
      const statuses={}; const bindings={};
      for(const namespace of ['profile','common']){const digest=catalogSourceSha256(catalogs.en[namespace]);const source_version='sha256:'+digest;
        bindings[namespace]={source_sha256:digest,source_version}; statuses[namespace]=Object.fromEntries(Object.keys(catalogs.en[namespace]).map(key=>[namespace+'.'+key,{status:'approved',source_version,critical:false,machine_generated:true,reviewed_by:'synthetic-reviewer',reviewer_qualification:'qualified_spanish_reviewer',reviewed_at:'2026-09-11T12:00:00Z'}]));}
      const approved=createCatalogResolver({catalogs,statuses,sourceBindings:bindings,criticalFallback:{renderState:'held_english_fallback',affordance:'available in English only'}});
      const mixed=request=>request.namespace==='profile'&&request.key==='you_chose'?approved.resolve(request):resolveCatalogMessage(request);
      window.renderSettings=(mode,displayMode='easy')=>{const locale=mode==='english'?'en':'es';const resolver=mode==='approved'?approved.resolve:resolveCatalogMessage;
        const selectedResolver=mode==='mixed'?mixed:resolver;
        flushSync(()=>createRoot(document.getElementById('root')).render(React.createElement(React.Fragment,null,
          React.createElement(SettingsContent,{locale,mode:displayMode,resolveMessage:selectedResolver}),
          React.createElement(ConfirmPreferenceContent,{locale,mode:displayMode,resolveMessage:selectedResolver}))));};
    `, resolveDir: resolve(root, 'apps/web'), loader: 'tsx' },
    plugins: [{
      name: 'next-server-stubs',
      setup(build: { onResolve(options: { filter: RegExp }, callback: (args: { path: string }) => unknown): void; onLoad(options: { filter: RegExp; namespace: string }, callback: (args: { path: string }) => unknown): void }) {
        build.onResolve({ filter: /^next\/(headers|navigation)$/ }, args => ({ path: args.path, namespace: 'next-server-stub' }));
        build.onLoad({ filter: /.*/, namespace: 'next-server-stub' }, args => ({ contents: args.path.endsWith('headers')
          ? 'export const cookies=async()=>({get:()=>undefined});'
          : 'export const redirect=()=>{};', loader: 'js' }));
      },
    }],
    bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', write: false, logLevel: 'silent' });
  const output = result.outputFiles[0]?.text;
  if (!output) throw new Error('Profile settings harness was not generated');
  return output;
}

async function render(page: import('@playwright/test').Page, mode: 'fallback' | 'approved' | 'english' | 'mixed', displayMode: 'easy' | 'standard' = 'easy') {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setContent('<div id="root"></div>');
  await page.evaluate(() => { (window as unknown as { process: unknown }).process = { env: { NODE_ENV: 'test' } }; });
  await page.addScriptTag({ content: await harness() });
  expect(errors).toEqual([]);
  await page.evaluate(({ mode, displayMode }) => (window as unknown as { renderSettings(a: string, b: string): void }).renderSettings(mode, displayMode), { mode, displayMode });
}

async function expectSharedPreferenceFallback(page: import('@playwright/test').Page) {
  const settings = page.locator('.ss-settings');
  const messages = settings.locator('[data-catalog-render-state]');
  await expect(messages).toHaveCount(12);
  expect(await messages.evaluateAll(nodes => nodes.every(node =>
    node.getAttribute('lang') === 'en'
    && node.getAttribute('data-catalog-render-state') === 'provisional_english_fallback'
    && node.hasAttribute('data-catalog-key'),
  ))).toBe(true);
  for (const spanish of [
    '¿Cómo quiere que se vea la aplicación?',
    'tamaño normal, más información en cada página',
    'Más grande y sencillo',
    'letras más grandes, una cosa a la vez y un botón para llamar a una persona',
    'Opción actual',
    'Puede cambiar esto cuando quiera.',
    'Idioma',
  ]) await expect(settings.getByText(spanish, { exact: true })).toHaveCount(0);
  const notice = settings.locator('[data-catalog-affordance="provisional_english_fallback"]');
  await expect(notice).toHaveCount(1);
  await expect(notice).toHaveText('Spanish translation is awaiting review.');
  const noticeId = await notice.evaluate(node => node.parentElement?.id ?? '');
  expect(noticeId).toBeTruthy();
  const groups = settings.locator('fieldset');
  await expect(groups).toHaveCount(2);
  expect(await groups.evaluateAll((nodes, id) => nodes.every(node => node.getAttribute('aria-describedby') === id), noticeId)).toBe(true);
}

test('shipped Spanish status renders governed English with associated review notices', async ({ page }) => {
  // what_bug_this_catches: raw Spanish catalog selection bypassing review state on settings and confirmation controls.
  await render(page, 'fallback');
  await expect(page.getByRole('heading', { name: 'Your settings' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Confirm your display choice' })).toBeVisible();
  await expect(page.locator('.ss-confirmation [role="status"]')).toContainText('You chose: Bigger and simpler');
  await expect(page.getByRole('button', { name: 'Yes, use this choice' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Go back without changing it' })).toHaveAttribute('href', '/settings');
  await expectSharedPreferenceFallback(page);
  await expect(page.locator('[data-catalog-affordance]')).toHaveCount(9);
  await expect(page.locator('[data-catalog-render-state="provisional_english_fallback"][lang="en"]')).toHaveCount(21);
  const confirmation = page.locator('.ss-confirmation');
  await expect(confirmation.locator('form')).toHaveAttribute('action', '/preferences');
  await expect(confirmation.locator('input[name="mode"]')).toHaveValue('easy');
  await expect(confirmation.locator('input[name="confirm"]')).toHaveValue('yes');
});

test('qualified synthetic approval renders exact Spanish without affordances', async ({ page }) => {
  // what_bug_this_catches: an approved resolver result being overwritten by component-local locale selection.
  await render(page, 'approved');
  await expect(page.getByRole('heading', { name: 'Sus ajustes' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Confirme su opción de pantalla' })).toBeVisible();
  await expect(page.locator('.ss-confirmation [role="status"]')).toContainText('Usted eligió: Más grande y sencillo');
  await expect(page.getByRole('button', { name: 'Sí, use esta opción' })).toBeVisible();
  await expect(page.getByRole('group', { name: '¿Cómo quiere que se vea la aplicación?' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Más grande y sencillo/u })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Idioma' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Español' })).toBeVisible();
  await expect(page.locator('[data-catalog-render-state="approved_spanish"][lang="es"]')).toHaveCount(21);
  await expect(page.locator('[data-catalog-affordance]')).toHaveCount(0);
});

test('mixed status fragments keep their own language, state, and deduplicated notice', async ({ page }) => {
  // what_bug_this_catches: a composed status borrowing approval or fallback provenance from its neighboring fragment.
  await render(page, 'mixed');
  const chosen = page.locator('[data-catalog-key="profile.you_chose"]');
  const confirmation = page.locator('[data-catalog-key="profile.easy_confirmation"]');
  await expect(chosen).toHaveText('Usted eligió');
  await expect(chosen).toHaveAttribute('lang', 'es');
  await expect(chosen).toHaveAttribute('data-catalog-render-state', 'approved_spanish');
  await expect(chosen).not.toHaveAttribute('aria-describedby', /.+/u);
  await expect(confirmation).toHaveText('Bigger and simpler — larger words, one thing at a time, a button to call a person');
  await expect(confirmation).toHaveAttribute('lang', 'en');
  await expect(confirmation).toHaveAttribute('data-catalog-render-state', 'provisional_english_fallback');
  const noticeId = await confirmation.getAttribute('aria-describedby');
  expect(noticeId).toBeTruthy();
  const notice = page.locator(`#${noticeId}`);
  await expect(notice).toHaveText('Spanish translation is awaiting review.');
  await expect(notice).toHaveAttribute('data-catalog-affordance', 'provisional_english_fallback');
  await expect(page.locator('.ss-confirmation [role="status"] + [data-catalog-affordance]')).toHaveCount(1);
});

test('English source and Standard confirmation retain exact form semantics', async ({ page }) => {
  // what_bug_this_catches: resolver migration changing mode selection, form payload, or English accessible names.
  await render(page, 'english', 'standard');
  await expect(page.locator('.ss-confirmation [role="status"]')).toContainText('You chose: Regular — normal size, more on each page');
  await expect(page.locator('[data-catalog-render-state="english_source"][lang="en"]')).toHaveCount(21);
  await expect(page.locator('[data-catalog-affordance]')).toHaveCount(0);
  await expect(page.locator('.ss-confirmation input[name="mode"]')).toHaveValue('standard');
});

test('real routes preserve locale, selected mode, and invalid-mode redirect', async ({ context, page }) => {
  // what_bug_this_catches: pure component evidence missing cookie wiring, route search params, or the fail-safe redirect.
  await context.addCookies([
    { name: 'seniorsocial.locale.v1', value: 'es', url: 'http://127.0.0.1:3110' },
    { name: 'seniorsocial.display-mode.v1', value: 'easy', url: 'http://127.0.0.1:3110' },
  ]);
  await page.goto('/settings');
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  await expect(page.getByRole('heading', { name: 'Your settings' })).toBeVisible();
  await expectSharedPreferenceFallback(page);
  for (const noticeId of [
    'settings-heading-translation',
    'settings-data-heading-translation',
    'settings-data-intro-translation',
    'settings-data-link-translation',
  ]) await expect(page.locator(`#${noticeId}`)).toHaveText('Spanish translation is awaiting review.');
  await page.goto('/preferences/confirm?mode=easy');
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  await expect(page.locator('.ss-confirmation [role="status"]')).toContainText('You chose: Bigger and simpler');
  await expect(page.locator('.ss-confirmation [data-catalog-render-state="provisional_english_fallback"][lang="en"]')).toHaveCount(5);
  await expect(page.locator('.ss-confirmation [data-catalog-affordance="provisional_english_fallback"]')).toHaveCount(4);
  await expect(page.locator('.ss-confirmation input[name="mode"]')).toHaveValue('easy');
  await page.goto('/preferences/confirm?mode=unsupported');
  await expect(page).toHaveURL(/\/settings$/u);
});
