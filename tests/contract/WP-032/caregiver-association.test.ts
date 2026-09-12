import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type * as ReactDOMServer from 'react-dom/server';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as catalogsModule from '../../../packages/i18n/src/catalogs';
import type { CatalogMessageRequest, CatalogResolution } from '../../../packages/i18n/src/catalogs';

const root = resolve(import.meta.dirname, '../../..');
const requireFromWeb = createRequire(resolve(root, 'apps/web/package.json'));
const { createElement } = requireFromWeb('react') as typeof import('react');
const { renderToStaticMarkup } = requireFromWeb('react-dom/server') as typeof ReactDOMServer;
const componentPath = resolve(root, 'apps/web/app/(shell)/caregiver/page.tsx');
const transpiled = ts.transpileModule(readFileSync(componentPath, 'utf8'), {
  compilerOptions: {
    esModuleInterop: true,
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: componentPath,
}).outputText;
const componentModule = { exports: {} as Record<string, unknown> };
const componentRequire = (specifier: string) => {
  if (specifier === '@seniorsocial/i18n/catalogs') return catalogsModule;
  return requireFromWeb(specifier);
};
new Function('exports', 'require', 'module', '__filename', '__dirname', transpiled)(
  componentModule.exports, componentRequire, componentModule, componentPath, resolve(componentPath, '..'),
);
const { CaregiverContent } = componentModule.exports as {
  CaregiverContent: (props: {
    readonly initialLocale?: 'en' | 'es';
    readonly resolveMessage?: (input: CatalogMessageRequest<'caregiver'>) => CatalogResolution;
  }) => Parameters<typeof renderToStaticMarkup>[0];
};

describe('WP-018/WP-031/WP-032 caregiver fallback associations', () => {
  it('deduplicates ordinary and critical notices while associating every fallback consumer', () => {
    // what_bug_this_catches: repeated warning text inside controls, or held English copy without an accessible qualifier.
    const markup = renderToStaticMarkup(createElement(CaregiverContent, { initialLocale: 'es' }));
    expect(markup.match(/data-catalog-affordance="provisional_english_fallback"/gu)).toHaveLength(1);
    expect(markup.match(/data-catalog-affordance="held_english_fallback"/gu)).toHaveLength(1);
    expect(markup).toContain('id="caregiver-ordinary-translation-state"');
    expect(markup).toContain('id="caregiver-critical-translation-state"');

    const governedTags = markup.match(/<span[^>]+data-catalog-render-state="(?:provisional_english_fallback|held_english_fallback)"[^>]*>/gu) ?? [];
    expect(governedTags).toHaveLength(19);
    for (const tag of governedTags) {
      const expectedId = tag.includes('held_english_fallback')
        ? 'caregiver-critical-translation-state'
        : 'caregiver-ordinary-translation-state';
      expect(tag).toContain(`aria-describedby="${expectedId}"`);
    }
    for (const button of markup.match(/<button[^>]*>[\s\S]*?<\/button>/gu) ?? []) {
      expect(button).not.toContain('Spanish translation is awaiting review.');
      expect(button).not.toContain('available in English only');
    }

    const mixedResolver = (input: CatalogMessageRequest<'caregiver'>): CatalogResolution => {
      const value = catalogsModule.resolveCatalogMessage(input);
      if (input.key !== 'page.title' && input.key !== 'consent.heading') return value;
      return {
        ...value,
        text: `Aprobado: ${input.key}`,
        renderedLocale: 'es',
        reviewStatus: 'approved',
        renderState: 'approved_spanish',
        fallbackReason: null,
        affordance: null,
      };
    };
    const mixed = renderToStaticMarkup(createElement(CaregiverContent, {
      initialLocale: 'es', resolveMessage: mixedResolver,
    }));
    expect(mixed.match(/data-catalog-affordance="provisional_english_fallback"/gu)).toHaveLength(1);
    expect(mixed.match(/data-catalog-affordance="held_english_fallback"/gu)).toHaveLength(1);
    for (const tag of mixed.match(/<span[^>]+data-catalog-render-state="(?:provisional_english_fallback|held_english_fallback)"[^>]*>/gu) ?? []) {
      const expectedId = tag.includes('held_english_fallback')
        ? 'caregiver-critical-translation-state'
        : 'caregiver-ordinary-translation-state';
      expect(tag).toContain(`aria-describedby="${expectedId}"`);
    }
  });

  it('renders English source and approved Spanish without false notices', () => {
    // what_bug_this_catches: a hardcoded warning surviving after resolver approval or appearing for English users.
    const english = renderToStaticMarkup(createElement(CaregiverContent, { initialLocale: 'en' }));
    expect(english).not.toContain('data-catalog-affordance');
    expect(english).not.toContain('aria-describedby="caregiver-');

    const approvedResolver = (input: CatalogMessageRequest<'caregiver'>): CatalogResolution => {
      const value = catalogsModule.resolveCatalogMessage({ ...input, locale: 'es' });
      return {
        ...value,
        text: `Aprobado: ${input.key}`,
        renderedLocale: 'es',
        reviewStatus: 'approved',
        renderState: 'approved_spanish',
        fallbackReason: null,
        affordance: null,
      };
    };
    const approved = renderToStaticMarkup(createElement(CaregiverContent, {
      initialLocale: 'es', resolveMessage: approvedResolver,
    }));
    expect(approved).toContain('lang="es"');
    expect(approved).toContain('data-catalog-render-state="approved_spanish"');
    expect(approved).not.toContain('data-catalog-affordance');
    expect(approved).not.toContain('aria-describedby="caregiver-');
  });

  it('preserves consent, read-back, and caregiver actions', async () => {
    // what_bug_this_catches: an accessibility-only refactor changing permission keys, request payloads, or endpoints.
    const source = await readFile(componentPath, 'utf8');
    for (const scope of ['view_schedule', 'book_rides', 'receive_alerts', 'view_assistance', 'view_profile']) {
      expect(source).toContain(`'${scope}'`);
    }
    expect(source).toContain("fetch('/api/v1/caregiver/invitations'");
    expect(source).toContain('/scopes`');
    expect(source).toContain("{ method: 'DELETE' }");
    expect(source).toContain("read_back_confirmed: values.get('read_back_confirmed') === 'on'");
    expect(source).toContain('scopes: scopeKeys.map');
    expect(source).toContain('name="read_back_confirmed" required type="checkbox"');
  });
});
