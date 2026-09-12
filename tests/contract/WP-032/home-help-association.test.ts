import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type * as ReactDOMServer from 'react-dom/server';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as catalogsModule from '../../../packages/i18n/src/catalogs';
import { resolveCatalogMessage, type CatalogResolution } from '../../../packages/i18n/src/catalogs';

const root = resolve(import.meta.dirname, '../../..');
const requireFromWeb = createRequire(resolve(root, 'apps/web/package.json'));
const { createElement } = requireFromWeb('react') as typeof import('react');
const { renderToStaticMarkup } = requireFromWeb('react-dom/server') as typeof ReactDOMServer;
const homePath = resolve(root, 'apps/web/app/(shell)/home/page.tsx');
const helpPath = resolve(root, 'apps/web/app/(shell)/help/page.tsx');

type RenderedComponent = (props: { readonly locale: 'en' | 'es' }) =>
  Parameters<typeof renderToStaticMarkup>[0];

const homeKeys = [
  'home_heading', 'home_intro', 'service_heading', 'service_body', 'service_link',
  'events_heading', 'events_body', 'events_link',
] as const;
const helpAssistanceKeys = [
  'emergency.heading', 'emergency.disclaimer', 'emergency.call_911',
] as const;
const helpShellKeys = ['help_heading', 'help_body', 'return_home'] as const;

function loadComponent(componentPath: string, exportName: 'HomeContent' | 'HelpContent'): RenderedComponent {
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
    if (specifier === '@seniorsocial/ui') return { LOCALE_STORAGE_KEY: 'ss_locale' };
    if (specifier === 'next/headers') return { cookies: async () => ({ get: () => undefined }) };
    if (specifier === './assistance-form') {
      return {
        AssistanceForm: ({ locale }: { readonly locale: string }) => createElement(
          'div', { 'data-assistance-form-locale': locale },
        ),
      };
    }
    return requireFromWeb(specifier);
  };
  new Function('exports', 'require', 'module', '__filename', '__dirname', transpiled)(
    componentModule.exports, componentRequire, componentModule, componentPath, resolve(componentPath, '..'),
  );
  return componentModule.exports[exportName] as RenderedComponent;
}

const HomeContent = loadComponent(homePath, 'HomeContent');
const HelpContent = loadComponent(helpPath, 'HelpContent');

function tagWithCatalogKey(markup: string, key: string): string {
  return markup.match(new RegExp(`<span[^>]*data-catalog-key="${escapeRegExp(key)}"[^>]*>`, 'u'))?.[0] ?? '';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function linkWithHref(markup: string, href: string): { tag: string; inner: string } {
  const match = markup.match(new RegExp(`<a[^>]*href="${escapeRegExp(href)}"[^>]*>([\\s\\S]*?)</a>`, 'u'));
  return { tag: match?.[0].match(/^<a[^>]*>/u)?.[0] ?? '', inner: match?.[1] ?? '' };
}

function attribute(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`${name}="([^"]+)"`, 'u'))?.[1];
}

function notice(markup: string, renderState: string): string {
  return markup.match(new RegExp(`<small[^>]*data-catalog-affordance="${renderState}"[^>]*>`, 'u'))?.[0] ?? '';
}

function expectMetadata(tag: string, resolution: CatalogResolution): void {
  expect(tag).not.toBe('');
  expect(attribute(tag, 'data-catalog-render-state')).toBe(resolution.renderState);
  expect(attribute(tag, 'data-catalog-review-status')).toBe(resolution.reviewStatus);
  expect(attribute(tag, 'data-catalog-fallback-reason')).toBe(resolution.fallbackReason ?? undefined);
  expect(attribute(tag, 'lang')).toBe(resolution.renderedLocale ?? undefined);
}

function textOnly(markup: string): string {
  return markup.replace(/<[^>]+>/gu, '');
}

describe('WP-032 home and help fallback association', () => {
  it('governs every Spanish route-owned value through the resolver', () => {
    // what_bug_this_catches: a route silently indexing draft Spanish catalogs instead of enforcing review state.
    for (const key of homeKeys) {
      const english = resolveCatalogMessage({ locale: 'en', namespace: 'shell', key });
      expect(resolveCatalogMessage({ locale: 'es', namespace: 'shell', key })).toMatchObject({
        found: true,
        text: english.text,
        renderedLocale: 'en',
        reviewStatus: 'draft',
        critical: false,
        renderState: 'provisional_english_fallback',
        fallbackReason: 'provisional_translation',
        affordance: 'Spanish translation is awaiting review.',
      });
    }
    for (const key of helpAssistanceKeys) {
      const english = resolveCatalogMessage({ locale: 'en', namespace: 'assistance', key });
      expect(resolveCatalogMessage({ locale: 'es', namespace: 'assistance', key })).toMatchObject({
        found: true,
        text: english.text,
        renderedLocale: 'en',
        reviewStatus: 'draft',
        critical: true,
        renderState: 'held_english_fallback',
        fallbackReason: 'critical_not_approved',
        affordance: 'available in English only',
      });
    }
    for (const key of helpShellKeys) {
      expect(resolveCatalogMessage({ locale: 'es', namespace: 'shell', key })).toMatchObject({
        found: true,
        renderedLocale: 'en',
        reviewStatus: 'draft',
        critical: false,
        renderState: 'provisional_english_fallback',
        fallbackReason: 'provisional_translation',
        affordance: 'Spanish translation is awaiting review.',
      });
    }
  });

  it('renders one adjacent home notice, accounts for every key, and describes the links themselves', () => {
    // what_bug_this_catches: repeated notices, unassociated fallback copy, or warning text entering a link name.
    const markup = renderToStaticMarkup(createElement(HomeContent, { locale: 'es' }));
    expect(markup.match(/data-catalog-affordance="provisional_english_fallback"/gu)).toHaveLength(1);
    expect(markup).not.toContain('data-catalog-affordance="held_english_fallback"');
    const provisionalNotice = notice(markup, 'provisional_english_fallback');
    const noticeId = attribute(provisionalNotice, 'id');
    expect(new Set(attribute(provisionalNotice, 'data-catalog-keys')?.split(' '))).toEqual(
      new Set(homeKeys.map(key => `shell.${key}`)),
    );

    for (const key of homeKeys) {
      const resolution = resolveCatalogMessage({ locale: 'es', namespace: 'shell', key });
      const valueTag = tagWithCatalogKey(markup, `shell.${key}`);
      expectMetadata(valueTag, resolution);
      if (key !== 'service_link' && key !== 'events_link') {
        expect(attribute(valueTag, 'aria-describedby'), key).toBe(noticeId);
      }
    }
    for (const [key, href] of [['service_link', '/services'], ['events_link', '/events']] as const) {
      const link = linkWithHref(markup, href);
      const resolution = resolveCatalogMessage({ locale: 'en', namespace: 'shell', key });
      expect(attribute(link.tag, 'aria-describedby')).toBe(noticeId);
      expect(link.inner).not.toContain('<small');
      expect(textOnly(link.inner)).toBe(resolution.text);
      expect(attribute(tagWithCatalogKey(link.inner, `shell.${key}`), 'aria-describedby')).toBeUndefined();
    }
  });

  it('keeps held-critical and provisional help notices distinct and fully associated', () => {
    // what_bug_this_catches: collapsing safety and ordinary review states or omitting route values from notice ownership.
    const markup = renderToStaticMarkup(createElement(HelpContent, { locale: 'es' }));
    expect(markup.match(/data-catalog-affordance="held_english_fallback"/gu)).toHaveLength(1);
    expect(markup.match(/data-catalog-affordance="provisional_english_fallback"/gu)).toHaveLength(1);
    const heldNotice = notice(markup, 'held_english_fallback');
    const provisionalNotice = notice(markup, 'provisional_english_fallback');
    const heldId = attribute(heldNotice, 'id');
    const provisionalId = attribute(provisionalNotice, 'id');
    expect(heldId).not.toBe(provisionalId);
    expect(new Set(attribute(heldNotice, 'data-catalog-keys')?.split(' '))).toEqual(
      new Set(helpAssistanceKeys.map(key => `assistance.${key}`)),
    );
    expect(new Set(attribute(provisionalNotice, 'data-catalog-keys')?.split(' '))).toEqual(
      new Set(helpShellKeys.map(key => `shell.${key}`)),
    );

    for (const key of helpAssistanceKeys) {
      const resolution = resolveCatalogMessage({ locale: 'es', namespace: 'assistance', key });
      const valueTag = tagWithCatalogKey(markup, `assistance.${key}`);
      expectMetadata(valueTag, resolution);
      if (key !== 'emergency.call_911') expect(attribute(valueTag, 'aria-describedby'), key).toBe(heldId);
    }
    for (const key of helpShellKeys) {
      const resolution = resolveCatalogMessage({ locale: 'es', namespace: 'shell', key });
      const valueTag = tagWithCatalogKey(markup, `shell.${key}`);
      expectMetadata(valueTag, resolution);
      if (key !== 'return_home') expect(attribute(valueTag, 'aria-describedby'), key).toBe(provisionalId);
    }

    const emergencyLink = linkWithHref(markup, 'tel:911');
    expect(attribute(emergencyLink.tag, 'aria-describedby')).toBe(heldId);
    expect(textOnly(emergencyLink.inner)).toBe('Call 911');
    expect(emergencyLink.inner).not.toContain('<small');
    const homeLink = linkWithHref(markup, '/home');
    expect(attribute(homeLink.tag, 'aria-describedby')).toBe(provisionalId);
    expect(textOnly(homeLink.inner)).toBe('Return home');
    expect(homeLink.inner).not.toContain('<small');
    expect(markup).toContain('data-assistance-form-locale="es"');
  });

  it('renders English without fallback notices or descriptions and keeps exact link text', () => {
    // what_bug_this_catches: English source copy inheriting Spanish fallback notices or altered control names.
    const homeMarkup = renderToStaticMarkup(createElement(HomeContent, { locale: 'en' }));
    const helpMarkup = renderToStaticMarkup(createElement(HelpContent, { locale: 'en' }));
    for (const markup of [homeMarkup, helpMarkup]) {
      expect(markup).not.toContain('data-catalog-affordance-group');
      expect(markup).not.toContain('aria-describedby');
    }
    expect(textOnly(linkWithHref(homeMarkup, '/services').inner)).toBe('Browse services');
    expect(textOnly(linkWithHref(homeMarkup, '/events').inner)).toBe('See events');
    expect(textOnly(linkWithHref(helpMarkup, 'tel:911').inner)).toBe('Call 911');
    expect(textOnly(linkWithHref(helpMarkup, '/home').inner)).toBe('Return home');

    const homeHeading = resolveCatalogMessage({ locale: 'en', namespace: 'shell', key: 'home_heading' });
    const emergencyHeading = resolveCatalogMessage({
      locale: 'en', namespace: 'assistance', key: 'emergency.heading',
    });
    expectMetadata(tagWithCatalogKey(homeMarkup, 'shell.home_heading'), homeHeading);
    expectMetadata(tagWithCatalogKey(helpMarkup, 'assistance.emergency.heading'), emergencyHeading);
  });

  it('keeps resolver-only catalog access and route/form structure intact', async () => {
    // what_bug_this_catches: localization hardening replacing navigation, the assistance form, or resolver enforcement.
    const [homeSource, helpSource] = await Promise.all([
      readFile(homePath, 'utf8'), readFile(helpPath, 'utf8'),
    ]);
    expect(homeSource).toContain('resolveCatalogMessage');
    expect(helpSource).toContain('resolveCatalogMessage');
    expect(homeSource).not.toMatch(/catalogs\s*\[/u);
    expect(homeSource).not.toMatch(/catalogs\.(?:en|es)/u);
    expect(helpSource).not.toMatch(/catalogs\s*\[/u);
    expect(helpSource).not.toMatch(/catalogs\.(?:en|es)/u);
    expect(homeSource).toContain('href="/services"');
    expect(homeSource).toContain('href="/events"');
    expect(helpSource).toContain('<AssistanceForm locale={locale} />');
    expect(helpSource).toContain('href="tel:911"');
    expect(helpSource).toContain('href="/home"');
  });
});
