import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type * as ReactDOMServer from 'react-dom/server';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { resolveCatalogMessage } from '../../../packages/i18n/src/catalogs';

const root = resolve(import.meta.dirname, '../../..');
const requireFromWeb = createRequire(resolve(root, 'apps/web/package.json'));
const { createElement } = requireFromWeb('react') as typeof import('react');
const { renderToStaticMarkup } = requireFromWeb('react-dom/server') as typeof ReactDOMServer;
const pagePath = resolve(root, 'apps/web/app/page.tsx');
let requestedLocale: 'en' | 'es' = 'es';
const transpiled = ts.transpileModule(readFileSync(pagePath, 'utf8'), {
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
  if (specifier === 'next/headers') {
    return { cookies: async () => ({ get: () => ({ value: requestedLocale }) }) };
  }
  if (specifier === '@seniorsocial/config') {
    return { loadConfig: () => ({ branding: { appName: 'SeniorSocial' } }) };
  }
  if (specifier === '@seniorsocial/ui') {
    return {
      AppShell: ({ children }: { readonly children: unknown }) => createElement('main', null, children),
      LOCALE_STORAGE_KEY: 'ss-locale',
      MODE_STORAGE_KEY: 'ss-mode',
    };
  }
  if (specifier === '@seniorsocial/ui/styles.css') return {};
  if (specifier === '@seniorsocial/i18n/catalogs') return { resolveCatalogMessage };
  return requireFromWeb(specifier);
};
new Function('exports', 'require', 'module', '__filename', '__dirname', transpiled)(
  pageModule.exports, pageRequire, pageModule, pagePath, resolve(pagePath, '..'),
);
const HomePage = (pageModule.exports as {
  default: () => Promise<Parameters<typeof renderToStaticMarkup>[0]>;
}).default;
const publicKeys = [
  'home_heading', 'home_intro', 'service_heading', 'service_body', 'service_link',
  'events_heading', 'events_body', 'events_link', 'help_heading', 'help_body', 'help_me',
] as const;

async function renderPage(locale: 'en' | 'es') {
  requestedLocale = locale;
  return renderToStaticMarkup(await HomePage());
}

describe('WP-032 public landing fallback association', () => {
  it('keeps every public landing value on the governed resolver contract', () => {
    // what_bug_this_catches: public Spanish copy bypassing review or using a notice that does not match its resolver state.
    for (const key of publicKeys) {
      const english = resolveCatalogMessage({ locale: 'en', namespace: 'shell', key });
      const spanish = resolveCatalogMessage({ locale: 'es', namespace: 'shell', key });
      expect(spanish, key).toMatchObject({
        found: true,
        text: english.text,
        renderedLocale: 'en',
        reviewStatus: 'draft',
        renderState: 'provisional_english_fallback',
        fallbackReason: 'provisional_translation',
        affordance: 'Spanish translation is awaiting review.',
      });
    }
  });

  it('renders each Spanish fallback with exact provenance and one associated notice', async () => {
    // what_bug_this_catches: correct fallback text reaching the page without machine-verifiable provenance or an accessible notice relationship.
    const markup = await renderPage('es');
    const noticeId = 'public-home-catalog-affordance';
    expect(markup.match(new RegExp(`id="${noticeId}"`, 'gu'))).toHaveLength(1);
    expect(markup.match(/data-catalog-affordance="provisional_english_fallback"/gu)).toHaveLength(1);
    expect(markup).toContain('role="note"');
    expect(markup).toContain('Spanish translation is awaiting review.');

    for (const key of publicKeys) {
      const tag = markup.match(new RegExp(`<span[^>]*data-catalog-key="shell\\.${key}"[^>]*>`, 'u'))?.[0];
      expect(tag, key).toBeTruthy();
      expect(tag, key).toContain(`aria-describedby="${noticeId}"`);
      expect(tag, key).toContain('data-catalog-render-state="provisional_english_fallback"');
      expect(tag, key).toContain('data-catalog-fallback-reason="provisional_translation"');
      expect(tag, key).toContain('data-catalog-review-status="draft"');
      expect(tag, key).toContain('lang="en"');
    }
  });

  it('does not falsely associate English values with a fallback notice', async () => {
    // what_bug_this_catches: English source copy being announced as provisional Spanish fallback.
    const markup = await renderPage('en');
    expect(markup).not.toContain('aria-describedby="public-home-catalog-affordance"');
    expect(markup).not.toContain('id="public-home-catalog-affordance"');
    expect(markup).not.toContain('data-catalog-affordance=');
    expect(markup).not.toContain('data-catalog-fallback-reason=');
  });

  it('renders exactly the three public navigation destinations', async () => {
    // what_bug_this_catches: an accessibility-only change accidentally altering or duplicating landing-page routes.
    const markup = await renderPage('es');
    expect([...markup.matchAll(/<a href="([^"]+)"/gu)].map((match) => match[1])).toEqual([
      '/services', '/events', '/help',
    ]);
  });
});
