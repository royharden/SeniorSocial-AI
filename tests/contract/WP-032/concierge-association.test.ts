import { readFileSync } from 'node:fs';
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
const componentPath = resolve(root, 'apps/web/app/concierge/concierge-client.tsx');
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
const { ConciergeView, resolveConciergeCopy } = componentModule.exports as {
  ConciergeView: (props: Record<string, unknown>) => Parameters<typeof renderToStaticMarkup>[0];
  resolveConciergeCopy: (
    locale: 'en' | 'es',
    resolver?: typeof catalogsModule.resolveCatalogMessage,
  ) => Record<string, CatalogResolution>;
};

const conversation = {
  id: 'conversation-1',
  organization_id: 'organization-1',
  resident_id: 'resident-1',
  locale: 'es',
  ai_enabled: true,
  status: 'active',
  handoff_request_id: null,
  created_at: '2026-09-11T00:00:00Z',
  updated_at: '2026-09-11T00:00:00Z',
  messages: [],
};

function render(
  locale: 'en' | 'es',
  resolver: typeof catalogsModule.resolveCatalogMessage = catalogsModule.resolveCatalogMessage,
  statusKind: 'intro' | 'handoff' | null = null,
) {
  return renderToStaticMarkup(createElement(ConciergeView, {
    answer: null,
    assistance: statusKind === 'handoff' ? { id: 'assist-1' } : null,
    busy: null,
    confirmed: false,
    conversation,
    copy: resolveConciergeCopy(locale, resolver),
    error: true,
    hydrated: true,
    onAsk: () => undefined,
    onConfirmedChange: () => undefined,
    onHandoff: () => undefined,
    onQuestionChange: () => undefined,
    onStart: () => undefined,
    question: '',
    status: '',
    statusKind,
  }));
}

describe('WP-011/WP-031/WP-032 concierge fallback associations', () => {
  it('deduplicates ordinary and critical notices with exact supplier provenance and stable ownership', () => {
    // what_bug_this_catches: repeated fallback text polluting control names or a deduplicated notice being stamped with another message's key.
    const markup = render('es');

    expect(markup.match(/data-catalog-affordance="provisional_english_fallback"/gu)).toHaveLength(1);
    expect(markup.match(/data-catalog-affordance="held_english_fallback"/gu)).toHaveLength(1);
    expect(markup).toContain('id="concierge-ordinary-translation-state"');
    expect(markup).toContain('id="concierge-critical-translation-state"');
    expect(markup).toContain('data-catalog-key="services.directory.heading" data-catalog-render-state="provisional_english_fallback" id="concierge-ordinary-translation-state"');
    expect(markup).toContain('data-catalog-key="assistance.request.error" data-catalog-render-state="held_english_fallback" id="concierge-critical-translation-state"');

    expect(markup).toMatch(/<h1 aria-describedby="concierge-ordinary-translation-state" id="concierge-heading">/u);
    expect(markup).toMatch(/<textarea aria-describedby="concierge-ordinary-translation-state"[^>]+id="concierge-question"/u);
    expect(markup).toMatch(/<h2 aria-describedby="concierge-critical-translation-state" id="human-handoff">/u);
    expect(markup).toMatch(/<p aria-describedby="concierge-critical-translation-state"><span[^>]+data-catalog-key="assistance.request.unassigned_notice"/u);
    expect(markup).toMatch(/<input aria-describedby="concierge-ordinary-translation-state"[^>]+type="checkbox"/u);
  });

  it('keeps fallback notices outside button, checkbox-label, and textarea-label accessible names', () => {
    // what_bug_this_catches: translation-state guidance becoming part of a control name instead of its description.
    const markup = render('es');
    for (const button of markup.match(/<button[^>]*>[\s\S]*?<\/button>/gu) ?? []) {
      expect(button).not.toContain('Spanish translation is awaiting review.');
      expect(button).not.toContain('available in English only');
    }
    for (const label of markup.match(/<label[^>]*>[\s\S]*?<\/label>/gu) ?? []) {
      expect(label).not.toContain('Spanish translation is awaiting review.');
      expect(label).not.toContain('available in English only');
    }
    expect(markup).toMatch(/<label for="concierge-question"><strong><span[^>]+>Search services<\/span><\/strong><\/label><textarea/u);
    expect(markup).toContain('placeholder="Food, transportation, housing…"');
  });

  it('selects the actual fallback supplier when earlier values are approved', () => {
    // what_bug_this_catches: notice provenance being hardcoded to a heading after that heading becomes approved.
    const mixedResolver = (input: CatalogMessageRequest): CatalogResolution => {
      const value = catalogsModule.resolveCatalogMessage(input);
      if (input.key !== 'directory.heading' && input.key !== 'request.error') return value;
      return {
        ...value,
        text: `Aprobado: ${input.namespace}.${input.key}`,
        renderedLocale: 'es',
        reviewStatus: 'approved',
        renderState: 'approved_spanish',
        fallbackReason: null,
        affordance: null,
      };
    };
    const markup = render('es', mixedResolver as typeof catalogsModule.resolveCatalogMessage);

    expect(markup).toContain('data-catalog-key="services.directory.intro" data-catalog-render-state="provisional_english_fallback" id="concierge-ordinary-translation-state"');
    expect(markup).toContain('data-catalog-key="assistance.request.form_heading" data-catalog-render-state="held_english_fallback" id="concierge-critical-translation-state"');
    expect(markup).not.toContain('data-catalog-key="services.directory.heading" data-catalog-render-state="approved_spanish" id="concierge-ordinary-translation-state"');

    expect(markup).toMatch(/<h1 id="concierge-heading"><span[^>]+data-catalog-key="services\.directory\.heading"/u);
    expect(markup).toMatch(/<p aria-atomic="true" aria-live="assertive" role="alert"><span[^>]+data-catalog-key="assistance\.request\.error"/u);
    const noticeIds = [...markup.matchAll(/id="(concierge-(?:ordinary|critical)-translation-state)"/gu)]
      .map(match => match[1]);
    expect(noticeIds).toEqual([
      'concierge-ordinary-translation-state',
      'concierge-critical-translation-state',
    ]);
    for (const describedBy of markup.matchAll(/aria-describedby="([^"]+)"/gu)) {
      expect(noticeIds, describedBy[0]).toContain(describedBy[1]);
    }
  });

  it('keeps live status copy governed and associated without changing the announced request id', () => {
    // what_bug_this_catches: a status update duplicating catalog text without provenance or losing its fallback description.
    const intro = render('es', catalogsModule.resolveCatalogMessage, 'intro');
    expect(intro).toMatch(/<p aria-atomic="true" aria-describedby="concierge-ordinary-translation-state" aria-live="polite" role="status"><span[^>]+data-catalog-key="services.directory.intro"[^>]+>Search verified local service information\.<\/span><\/p>/u);

    const handoff = render('es', catalogsModule.resolveCatalogMessage, 'handoff');
    expect(handoff).toMatch(/<p aria-atomic="true" aria-describedby="concierge-critical-translation-state" aria-live="polite" role="status"><span[^>]+data-catalog-key="assistance.request.saved_heading"[\s\S]+data-catalog-key="assistance.request.pending_state"[\s\S]+assist-1<\/p>/u);
  });

  it('renders approved Spanish and English source copy without false notices or associations', () => {
    // what_bug_this_catches: stale notice IDs surviving after approval, creating either false warnings or dangling descriptions.
    const approvedResolver = (input: CatalogMessageRequest): CatalogResolution => {
      const value = catalogsModule.resolveCatalogMessage({ ...input, locale: 'es' });
      return {
        ...value,
        text: `Aprobado: ${input.namespace}.${input.key}`,
        renderedLocale: 'es',
        reviewStatus: 'approved',
        renderState: 'approved_spanish',
        fallbackReason: null,
        affordance: null,
      };
    };

    for (const markup of [
      render('en', catalogsModule.resolveCatalogMessage, 'handoff'),
      render('es', approvedResolver as typeof catalogsModule.resolveCatalogMessage, 'handoff'),
    ]) {
      expect(markup).not.toContain('data-catalog-affordance');
      expect(markup).not.toContain('concierge-ordinary-translation-state');
      expect(markup).not.toContain('concierge-critical-translation-state');
      expect(markup).not.toContain('aria-describedby');
    }
  });

  it('preserves concierge creation, messaging, handoff, and live-region behavior', () => {
    // what_bug_this_catches: an accessibility refactor silently changing endpoints, payloads, or status announcements.
    const source = readFileSync(componentPath, 'utf8');
    expect(source).toContain("fetch('/api/v1/concierge/conversations', { method: 'POST' })");
    expect(source).toContain('/messages`');
    expect(source).toContain('JSON.stringify({ text: question, locale })');
    expect(source).toContain('/handoff`');
    expect(source).toContain('setAssistance(created)');
    expect(source).toContain('aria-live="polite"');
    expect(source).toContain('aria-live="assertive"');
    expect(source).toContain('aria-relevant="additions text"');
  });
});
