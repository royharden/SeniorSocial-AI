import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type * as ReactDOMServer from 'react-dom/server';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as catalogsModule from '../../../packages/i18n/src/catalogs';
import type { CatalogResolution } from '../../../packages/i18n/src/catalogs';

const root = resolve(import.meta.dirname, '../../..');
const requireFromWeb = createRequire(resolve(root, 'apps/web/package.json'));
const { createElement } = requireFromWeb('react') as typeof import('react');
const { renderToStaticMarkup } = requireFromWeb('react-dom/server') as typeof ReactDOMServer;
const provisionalAffordance = 'Spanish translation is awaiting review.';
const componentPath = resolve(root, 'apps/web/app/reports/reports-client.tsx');
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
  if (specifier === './reports.module.css') return {};
  return requireFromWeb(specifier);
};
new Function('exports', 'require', 'module', '__filename', '__dirname', transpiled)(
  componentModule.exports,
  componentRequire,
  componentModule,
  componentPath,
  resolve(componentPath, '..'),
);
const { CatalogNotice, CatalogOption, CatalogText, catalogDescriptionId, resolveReportsCopy } = componentModule.exports as {
  CatalogNotice: (props: { readonly id: string; readonly value: CatalogResolution }) => Parameters<typeof renderToStaticMarkup>[0];
  CatalogOption: (props: { readonly optionValue: string; readonly value: CatalogResolution }) => Parameters<typeof renderToStaticMarkup>[0];
  CatalogText: (props: { readonly value: CatalogResolution }) => Parameters<typeof renderToStaticMarkup>[0];
  catalogDescriptionId: (value: CatalogResolution, id: string) => string | undefined;
  resolveReportsCopy: (locale: 'en' | 'es') => Readonly<Record<string, CatalogResolution>>;
};

describe('WP-032 approval-aware reports consumer', () => {
  it('resolves every visible report label through governed catalog metadata', () => {
    // what_bug_this_catches: the report page reintroducing a component-local Spanish dictionary that bypasses review state.
    const english = resolveReportsCopy('en');
    const spanish = resolveReportsCopy('es');
    expect(Object.keys(spanish)).toEqual(Object.keys(english));
    expect(Object.keys(spanish)).toHaveLength(28);
    for (const name of Object.keys(spanish) as Array<keyof typeof spanish>) {
      expect(english[name], name).toMatchObject({
        found: true,
        renderedLocale: 'en',
        renderState: 'english_source',
        fallbackReason: null,
        affordance: null,
      });
      expect(spanish[name], name).toMatchObject({
        found: true,
        renderedLocale: 'en',
        renderState: 'provisional_english_fallback',
        fallbackReason: 'provisional_translation',
        affordance: provisionalAffordance,
      });
      expect(spanish[name].text, name).toBe(english[name].text);
    }
  });

  it('separates the exact fallback notice from the governed value accessible name', () => {
    // what_bug_this_catches: the English fallback notice becoming part of every heading or control name instead of its description.
    const resolution = resolveReportsCopy('es').title;
    const valueMarkup = renderToStaticMarkup(createElement(CatalogText, { value: resolution }));
    const noticeMarkup = renderToStaticMarkup(createElement(CatalogNotice, {
      id: 'reports-title-notice',
      value: resolution,
    }));
    expect(valueMarkup).toBe(
      '<span data-catalog-fallback-reason="provisional_translation" data-catalog-key="reports.title" '
      + 'data-catalog-render-state="provisional_english_fallback" data-review-status="draft" lang="en">'
      + 'Aggregate reports</span>',
    );
    expect(valueMarkup).not.toContain(provisionalAffordance);
    expect(noticeMarkup).toBe(
      '<small data-catalog-affordance="provisional_english_fallback" data-catalog-key="reports.title" '
      + 'id="reports-title-notice" lang="en">Spanish translation is awaiting review.</small>',
    );
    expect(catalogDescriptionId(resolution, 'reports-title-notice')).toBe('reports-title-notice');
  });

  it('keeps native option children valid and moves its fallback notice to the select description', () => {
    // what_bug_this_catches: invalid rich option children or the review affordance polluting the selected control name.
    const resolution = resolveReportsCopy('es').allChannels;
    const markup = renderToStaticMarkup(createElement(CatalogOption, { optionValue: '', value: resolution }));
    expect(markup).toBe(
      '<option data-catalog-fallback-reason="provisional_translation" data-catalog-key="reports.all_channels" '
      + 'data-catalog-render-state="provisional_english_fallback" data-review-status="draft" lang="en" '
      + 'value="">All declared channels</option>',
    );
    expect(markup).not.toContain('<small');
    expect(markup).not.toContain(provisionalAffordance);
    expect(markup.match(/<option/gu)).toHaveLength(1);
  });

  it('renders approved Spanish and English source values without false notices', () => {
    // what_bug_this_catches: a consumer hardcoding a review warning after the resolver allows Spanish, or warning English users.
    const approved: CatalogResolution = {
      found: true,
      text: 'Texto aprobado',
      requestedLocale: 'es',
      renderedLocale: 'es',
      namespace: 'reports',
      key: 'title',
      reviewStatus: 'approved',
      critical: false,
      machineGenerated: false,
      renderState: 'approved_spanish',
      fallbackReason: null,
      affordance: null,
    };
    for (const resolution of [approved, resolveReportsCopy('en').title]) {
      const valueMarkup = renderToStaticMarkup(createElement(CatalogText, { value: resolution }));
      const noticeMarkup = renderToStaticMarkup(createElement(CatalogNotice, { id: 'notice', value: resolution }));
      expect(valueMarkup).not.toContain('data-catalog-affordance');
      expect(valueMarkup).not.toContain(provisionalAffordance);
      expect(noticeMarkup).toBe('');
      expect(catalogDescriptionId(resolution, 'notice')).toBeUndefined();
    }
  });

  it('uses explicit label and description associations without nesting notices in controls', async () => {
    // what_bug_this_catches: visually adjacent warnings that are either unassociated or included in button/label text.
    const source = await readFile(componentPath, 'utf8');
    for (const field of ['from', 'to', 'channel']) {
      expect(source).toContain(`htmlFor="reports-${field}"`);
      expect(source).toContain(`id="reports-${field}"`);
    }
    const associations = [
      ['title', 'reports-title-notice'],
      ['intro', 'reports-intro-notice'],
      ['filters', 'reports-filters-notice'],
      ['from', 'reports-from-notice'],
      ['to', 'reports-to-notice'],
      ['channel', 'reports-channel-notice'],
      ['allChannels', 'reports-all-channels-notice'],
      ['apply', 'reports-apply-notice'],
      ['metadata', 'reports-metadata-notice'],
      ['asOf', 'reports-as-of-notice'],
      ['scope', 'reports-scope-notice'],
      ['completeness', 'reports-completeness-notice'],
      ['sourceVersion', 'reports-source-version-notice'],
      ['knownOmissions', 'reports-known-omissions-notice'],
      ['noneDeclared', 'reports-known-omissions-none-notice'],
      ['overlapUncertainty', 'reports-overlap-uncertainty-notice'],
      ['noneDeclared', 'reports-overlap-uncertainty-none-notice'],
      ['rows', 'reports-rows-notice'],
      ['period', 'reports-period-notice'],
      ['channel', 'reports-table-channel-notice'],
      ['metric', 'reports-metric-notice'],
      ['count', 'reports-count-notice'],
      ['empty', 'reports-empty-notice'],
      ['exportJson', 'reports-export-json-notice'],
      ['exportCsv', 'reports-export-csv-notice'],
    ] as const;
    for (const [key, notice] of associations) {
      expect(source, `${key} description`).toContain(`catalogDescriptionId(text.${key}, '${notice}')`);
      expect(source, `${key} notice`).toContain(`<CatalogNotice id="${notice}" value={text.${key}} />`);
    }
    const declaredNoticeIds = [...source.matchAll(/<CatalogNotice id="([^"]+)"/gu)].map(match => match[1]);
    expect(declaredNoticeIds).toHaveLength(associations.length);
    expect(new Set(declaredNoticeIds).size).toBe(declaredNoticeIds.length);

    for (const element of source.matchAll(/<(?:h[1-6]|button|label|option)\b[^>]*>[\s\S]*?<\/(?:h[1-6]|button|label|option)>/gu)) {
      expect(element[0]).not.toContain('<CatalogNotice');
    }
    expect(source).toContain("].filter(Boolean).join(' ') || undefined");
    expect(source).toContain('<CatalogNotice id={statusNoticeId} value={status} />');
    expect(source).toContain('<CatalogNotice id={noticeId} value={suppressed} />');
    expect(source).not.toContain('` — ${value.affordance}`');
  });

  it('uses shell locale while preserving filters, protected counts, and export payloads', async () => {
    // what_bug_this_catches: a copy migration changing reporting semantics, API scope, or restoring a second language toggle.
    const source = await readFile(resolve(root, 'apps/web/app/reports/reports-client.tsx'), 'utf8');
    expect(source).toContain("document.querySelector<HTMLElement>('.ss-app')?.dataset.locale");
    expect(source).toContain('document.documentElement.lang');
    expect(source).toContain('resolveCatalogMessage');
    expect(source).not.toContain('const copy=');
    expect(source).not.toContain('Informes agregados');
    expect(source).not.toContain("setLocale(value => value === 'en' ? 'es' : 'en')");
    expect(source).toContain("for (const key of ['from', 'to', 'channel'])");
    expect(source).toContain("query.append(key, key === 'channel' ? value : `${value}T00:00:00.000Z`)");
    expect(source).toContain("report_name: 'channel-activity', format, filters: report?.filters ?? {}");
    expect(source).toContain('return row.suppressed ? <>');
    expect(source).toContain('</> : String(row.count)');
    for (const key of ['as_of', 'scope', 'completeness', 'source_version', 'known_omissions',
      'overlap_uncertainty', 'none_declared', 'period', 'metric']) expect(source).toContain(`'${key}'`);
  });
});
