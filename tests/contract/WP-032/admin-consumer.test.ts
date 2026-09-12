import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type * as ReactDOMServer from 'react-dom/server';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as catalogsModule from '../../../packages/i18n/src/catalogs';
import { catalogs, resolveCatalogMessage, type CatalogKey, type CatalogMessageRequest, type CatalogResolution } from '../../../packages/i18n/src/catalogs';

const root = resolve(import.meta.dirname, '../../..');
const componentPath = resolve(root, 'apps/web/app/(shell)/admin/admin-dashboard.tsx');
const requireFromWeb = createRequire(resolve(root, 'apps/web/package.json'));
const { createElement } = requireFromWeb('react') as typeof import('react');
const { renderToStaticMarkup } = requireFromWeb('react-dom/server') as typeof ReactDOMServer;
const transpiled = ts.transpileModule(readFileSync(componentPath, 'utf8'), {
  compilerOptions: { esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  fileName: componentPath,
}).outputText;
const componentModule = { exports: {} as Record<string, unknown> };
const componentRequire = (specifier: string) => {
  if (specifier === '@seniorsocial/i18n/catalogs') return catalogsModule;
  if (specifier.endsWith('/queue.ts')) return { loadQueue: async () => ({ items: [], meta: { next_cursor: null, total_known: true } }) };
  if (specifier === './admin.module.css') return {};
  return requireFromWeb(specifier);
};
new Function('exports', 'require', 'module', '__filename', '__dirname', transpiled)(
  componentModule.exports, componentRequire, componentModule, componentPath, resolve(componentPath, '..'),
);
const { AdminDashboardContent } = componentModule.exports as {
  AdminDashboardContent: (props: {
    readonly locale: 'en' | 'es';
    readonly resolveMessage?: (request: CatalogMessageRequest<'admin'>) => CatalogResolution;
  }) => Parameters<typeof renderToStaticMarkup>[0];
};

const criticalKeys = [
  'action.account_hold', 'action.account_release', 'queue.moderation', 'state.held_for_review',
  'state.awaiting_review', 'state.keep', 'state.remove', 'state.warn', 'item.immediate_safety',
] as const satisfies readonly CatalogKey<'admin'>[];
const ordinaryKeys = [
  'page.title', 'page.intro', 'section.queues', 'section.users', 'section.content', 'section.analytics',
  'queue.assistance', 'queue.rides', 'queue.translation', 'action.create', 'analytics.users', 'role.staff',
] as const satisfies readonly CatalogKey<'admin'>[];

describe('WP-032 approval-aware admin consumer', () => {
  it('holds critical admin decisions and actions in English', () => {
    // what_bug_this_catches: provisional Spanish changing the meaning of moderation or account hold actions.
    for (const key of criticalKeys) {
      const english = resolveCatalogMessage({ locale: 'en', namespace: 'admin', key });
      expect(resolveCatalogMessage({ locale: 'es', namespace: 'admin', key }), key).toMatchObject({
        text: english.text,
        renderedLocale: 'en',
        reviewStatus: 'draft',
        critical: true,
        renderState: 'held_english_fallback',
        fallbackReason: 'critical_not_approved',
        affordance: 'available in English only',
      });
    }
  });

  it('keeps ordinary provisional admin copy in governed English', () => {
    // what_bug_this_catches: the old component-local Spanish dictionaries bypassing qualified review.
    for (const key of ordinaryKeys) {
      const english = resolveCatalogMessage({ locale: 'en', namespace: 'admin', key });
      expect(resolveCatalogMessage({ locale: 'es', namespace: 'admin', key }), key).toMatchObject({
        text: english.text,
        renderedLocale: 'en',
        reviewStatus: 'draft',
        critical: false,
        renderState: 'provisional_english_fallback',
        fallbackReason: 'provisional_translation',
        affordance: 'Spanish translation is awaiting review.',
      });
    }
  });

  it('renders controlled qualified Spanish without fallback notices', () => {
    // what_bug_this_catches: the consumer ignoring a future qualified resolver result or hardcoding fallback labels.
    const approved = (request: CatalogMessageRequest<'admin'>): CatalogResolution => {
      const english = resolveCatalogMessage({ ...request, locale: 'en' });
      return {
        ...english,
        text: catalogs.es.admin[request.key],
        requestedLocale: 'es', renderedLocale: 'es', reviewStatus: 'approved', critical: english.critical,
        machineGenerated: true, renderState: 'approved_spanish', fallbackReason: null, affordance: null,
      };
    };
    const markup = renderToStaticMarkup(createElement(AdminDashboardContent, { locale: 'es', resolveMessage: approved }));
    expect(markup).toContain('lang="es">Panel del personal</span>');
    expect(markup).toContain('lang="es">Moderación</span>');
    expect(markup).toContain('data-catalog-render-state="approved_spanish"');
    expect(markup).not.toContain('data-catalog-affordance');
    expect(markup).not.toContain('Spanish translation is awaiting review.');
    expect(markup).not.toContain('available in English only');
  });

  it('uses the shell locale and preserves every protected endpoint and mutation field', async () => {
    // what_bug_this_catches: localization changing admin protocol, trusting a second locale toggle, or flashing English before hydration.
    const source = await readFile(componentPath, 'utf8');
    expect(source).toContain("from '@seniorsocial/i18n/catalogs'");
    expect(source).toContain("document.querySelector<HTMLElement>('.ss-app')?.dataset.locale");
    expect(source).toContain('data-admin-locale-pending');
    expect(source).not.toContain('const copy=');
    expect(source).not.toContain('const queueNames=');
    expect(source).not.toContain('const stateNames');
    expect(source).not.toContain("setLocale(value=>value==='en'?'es':'en')");
    for (const endpoint of [
      "fetch('/api/v1/admin/users'", 'fetch(`/api/v1/admin/users/${user.id}`',
      'fetch(`/api/v1/admin/${key}`', "fetch('/api/v1/admin/analytics'",
    ]) expect(source).toContain(endpoint);
    expect(source).toContain('JSON.stringify({ account_state: accountState, expected_version: user.version })');
    expect(source).toContain("'idempotency-key': crypto.randomUUID()");
    expect(source).toContain("values.publish_at = new Date(values.publish_at).toISOString()");
    expect(source).toContain('row.tile.unit_definition');
    expect(source).toContain('row.tile.known_gap');
    expect(source).toContain('data-admin-unknown-value');
    expect(source).not.toContain('dangerouslySetInnerHTML');
  });
});
