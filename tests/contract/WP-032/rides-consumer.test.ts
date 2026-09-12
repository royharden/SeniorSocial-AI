import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type * as ReactDOMServer from 'react-dom/server';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as catalogsModule from '../../../packages/i18n/src/catalogs';
import {
  catalogSourceSha256, createCatalogResolver, resolveCatalogMessage, type CatalogResolution,
} from '../../../packages/i18n/src/catalogs';

// Resolve React from the app that owns these components, matching its runtime.
const appRequire = createRequire(resolve('apps/web/package.json'));
const { createElement } = appRequire('react') as typeof import('react');
const { renderToStaticMarkup } = appRequire('react-dom/server') as typeof ReactDOMServer;
const componentPath = resolve('apps/web/app/(shell)/rides/ride-request-form.tsx');
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
  return appRequire(specifier);
};
// Compile the real TSX module because the repo's browser tsconfig intentionally preserves JSX.
new Function('exports', 'require', 'module', '__filename', '__dirname', transpiled)(
  componentModule.exports, componentRequire, componentModule, componentPath, resolve(componentPath, '..'),
);
const { CatalogOption, CatalogText } = componentModule.exports as {
  CatalogOption: (props: { readonly optionValue: string; readonly value: CatalogResolution }) => Parameters<typeof renderToStaticMarkup>[0];
  CatalogText: (props: { readonly value: CatalogResolution }) => Parameters<typeof renderToStaticMarkup>[0];
};
const pagePath = resolve('apps/web/app/(shell)/rides/page.tsx');
const transpiledPage = ts.transpileModule(readFileSync(pagePath, 'utf8'), {
  compilerOptions: {
    esModuleInterop: true,
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: pagePath,
}).outputText;
const pageModule = { exports: {} as Record<string, unknown> };
const pageRequire = (specifier: string) => {
  if (specifier === '@seniorsocial/i18n/catalogs') return catalogsModule;
  if (specifier === '@seniorsocial/ui') return { LOCALE_STORAGE_KEY: 'ss-locale' };
  if (specifier === 'next/headers') return { cookies: async () => ({ get: () => undefined }) };
  if (specifier === './ride-request-form') return { RideRequestForm: () => null };
  return appRequire(specifier);
};
new Function('exports', 'require', 'module', '__filename', '__dirname', transpiledPage)(
  pageModule.exports, pageRequire, pageModule, pagePath, resolve(pagePath, '..'),
);
const { RidesHeader } = pageModule.exports as {
  RidesHeader: (props: {
    readonly title: CatalogResolution;
    readonly disclaimer: CatalogResolution;
  }) => Parameters<typeof renderToStaticMarkup>[0];
};
const english = { 'accessibility.wheelchair': 'Wheelchair' };
const spanish = { 'accessibility.wheelchair': 'Silla de ruedas' };
const digest = catalogSourceSha256(english);
const sourceVersion = `sha256:${digest}`;
const held = {
  status: 'awaiting_review', source_version: sourceVersion, critical: true,
  machine_generated: true, render_state: 'held_english_fallback',
};

function resolver(status: unknown) {
  return createCatalogResolver({
    catalogs: { en: { rides: english }, es: { rides: spanish } },
    statuses: { rides: { 'rides.accessibility.wheelchair': status } },
    sourceBindings: { rides: { source_version: sourceVersion, source_sha256: digest } },
    criticalFallback: { renderState: 'held_english_fallback', affordance: 'available in English only' },
    provisionalAffordance: 'Spanish translation is awaiting review.',
  });
}

describe('WP-032 rides resolver consumer', () => {
  it('renders one associated header notice with exact catalog provenance', () => {
    // what_bug_this_catches: the rides header warning being unassociated, duplicated, or attributed to the wrong catalog value.
    const title = resolveCatalogMessage({ locale: 'es', namespace: 'rides', key: 'page.title' });
    const disclaimer = resolveCatalogMessage({ locale: 'es', namespace: 'rides', key: 'page.disclaimer' });
    const markup = renderToStaticMarkup(createElement(RidesHeader, { title, disclaimer }));

    expect(markup.match(/data-catalog-affordance=/gu)).toHaveLength(1);
    expect(markup).toMatch(
      /<h1(?=[^>]*aria-describedby="rides-header-catalog-affordance")(?=[^>]*id="rides-heading")[^>]*>/u,
    );
    expect(markup).not.toMatch(/<div[^>]*aria-describedby=/u);
    expect(markup).toContain('id="rides-header-catalog-affordance"');
    expect(markup).toContain('data-catalog-key="rides.page.title"');
    expect(markup).toContain(`data-catalog-render-state="${title.renderState}"`);
    expect(markup).toContain('data-catalog-key="rides.page.disclaimer"');
    expect(markup).toContain(`data-catalog-render-state="${disclaimer.renderState}"`);
    expect(markup).toContain(
      `data-catalog-affordance="${title.renderState}" data-catalog-key="rides.page.title"`,
    );
  });

  it('attributes a disclaimer-only fallback notice to the disclaimer resolution', () => {
    // what_bug_this_catches: title metadata being stamped onto a notice selected from a differently resolved disclaimer.
    const title: CatalogResolution = {
      found: true, text: 'Solicitud de transporte', requestedLocale: 'es', renderedLocale: 'es',
      namespace: 'rides', key: 'page.title', reviewStatus: 'approved', critical: false,
      machineGenerated: false, renderState: 'approved_spanish', fallbackReason: null, affordance: null,
    };
    const disclaimer = resolveCatalogMessage({ locale: 'es', namespace: 'rides', key: 'page.disclaimer' });
    const markup = renderToStaticMarkup(createElement(RidesHeader, { title, disclaimer }));

    expect(markup.match(/data-catalog-affordance=/gu)).toHaveLength(1);
    expect(markup).toContain(
      `data-catalog-affordance="${disclaimer.renderState}" data-catalog-key="rides.page.disclaimer"`,
    );
    expect(markup).not.toContain('data-catalog-affordance="approved_spanish"');
  });

  it('omits header notices and associations for approved Spanish and English', () => {
    // what_bug_this_catches: a stale fallback association remaining after every header value is safe to render directly.
    const approvedTitle: CatalogResolution = {
      found: true, text: 'Solicitud de transporte', requestedLocale: 'es', renderedLocale: 'es',
      namespace: 'rides', key: 'page.title', reviewStatus: 'approved', critical: false,
      machineGenerated: false, renderState: 'approved_spanish', fallbackReason: null, affordance: null,
    };
    const approvedDisclaimer: CatalogResolution = {
      ...approvedTitle,
      text: 'Enviar una solicitud no reserva ni confirma el transporte.',
      key: 'page.disclaimer',
    };
    const englishTitle = resolveCatalogMessage({ locale: 'en', namespace: 'rides', key: 'page.title' });
    const englishDisclaimer = resolveCatalogMessage({ locale: 'en', namespace: 'rides', key: 'page.disclaimer' });

    for (const [title, disclaimer] of [
      [approvedTitle, approvedDisclaimer],
      [englishTitle, englishDisclaimer],
    ] as const) {
      const markup = renderToStaticMarkup(createElement(RidesHeader, { title, disclaimer }));
      expect(markup).not.toContain('data-catalog-affordance');
      expect(markup).not.toContain('aria-describedby');
      expect(markup).not.toContain('rides-header-catalog-affordance');
    }
  });

  it.each([
    [held, 'held_english_fallback', 'available in English only'],
    [{ ...held, status: 'invalidated' }, 'invalidated_english_fallback', 'available in English only'],
    [{ ...held, source_version: `sha256:${'0'.repeat(64)}` }, 'source_drift_english_fallback', 'available in English only'],
    [{ ...held, render_state: 'unexpected' }, 'metadata_error_english_fallback', 'available in English only'],
    [{ ...held, critical: false }, 'provisional_english_fallback', 'Spanish translation is awaiting review.'],
  ])('renders each nonempty resolver affordance beside its exact ride value (%s)', (status, renderState, affordance) => {
    // what_bug_this_catches: a fail-safe resolver value silently losing its notice or the notice being attributed to another field.
    const resolution = resolver(status).resolve({ locale: 'es', namespace: 'rides', key: 'accessibility.wheelchair' });

    expect(resolution.renderState).toBe(renderState);
    expect(resolution.affordance).toBe(affordance);
    const markup = renderToStaticMarkup(CatalogText({ value: resolution }));
    expect(markup).toContain(`data-catalog-render-state="${renderState}"`);
    expect(markup).toContain(`data-catalog-fallback-reason="${resolution.fallbackReason}"`);
    expect(markup).toContain('lang="en">Wheelchair</span><small');
    expect(markup).toContain(`data-catalog-affordance="${renderState}"`);
    expect(markup).toContain(`lang="en"> ${affordance}</small>`);
    expect(markup.match(/data-catalog-key="rides\.accessibility\.wheelchair"/gu)).toHaveLength(2);
  });

  it('keeps held Spanish native options valid, marked, and visibly qualified', () => {
    // what_bug_this_catches: invalid nested option markup or a held option displaying English without its resolver-supplied notice.
    const resolution = resolver(held).resolve({ locale: 'es', namespace: 'rides', key: 'accessibility.wheelchair' });

    expect(resolution).toMatchObject({
      text: 'Wheelchair', renderedLocale: 'en', renderState: 'held_english_fallback',
      affordance: 'available in English only',
    });
    const markup = renderToStaticMarkup(CatalogOption({ optionValue: 'wheelchair', value: resolution }));
    expect(markup).toMatch(/^<option [^>]*value="wheelchair"[^>]*>Wheelchair — available in English only<\/option>$/u);
    expect(markup).toContain('data-catalog-key="rides.accessibility.wheelchair"');
    expect(markup).toContain('data-catalog-affordance="held_english_fallback"');
    expect(markup).not.toContain('<small');
  });

  it('shows approved Spanish and English source values without false notices', () => {
    // what_bug_this_catches: an approval-aware consumer appending a stale warning after approval or warning English users.
    const approved = resolver({
      ...held, status: 'approved', reviewed_by: 'reviewer',
      reviewer_qualification: 'qualified bilingual reviewer', reviewed_at: '2026-09-11T00:00:00Z',
    }).resolve({ locale: 'es', namespace: 'rides', key: 'accessibility.wheelchair' });
    const englishSource = resolver(held).resolve({ locale: 'en', namespace: 'rides', key: 'accessibility.wheelchair' });

    for (const [resolution, expected] of [[approved, 'Silla de ruedas'], [englishSource, 'Wheelchair']] as const) {
      expect(resolution.text).toBe(expected);
      expect(resolution.affordance).toBeNull();
      expect(resolution.fallbackReason).toBeNull();
      const textMarkup = renderToStaticMarkup(CatalogText({ value: resolution }));
      const optionMarkup = renderToStaticMarkup(CatalogOption({ optionValue: 'wheelchair', value: resolution }));
      expect(textMarkup).toContain(`>${expected}</span>`);
      expect(optionMarkup).toContain(`>${expected}</option>`);
      expect(textMarkup).not.toContain('data-catalog-affordance');
      expect(optionMarkup).not.toContain('data-catalog-affordance');
      expect(textMarkup).not.toContain('<small');
    }
  });
});
