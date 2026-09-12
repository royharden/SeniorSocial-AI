import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveCatalogMessage } from '../../../packages/i18n/src/catalogs';

const source = readFileSync(new URL('../../../apps/web/app/concierge/concierge-client.tsx', import.meta.url), 'utf8');
const spanishAssistanceDrafts = JSON.parse(readFileSync(
  new URL('../../../packages/i18n/es/assistance.json', import.meta.url), 'utf8',
)) as Readonly<Record<string, string>>;

describe('WP-011 concierge UI source', () => {
  it('renders resolver text and its exact nonempty affordance with catalog state metadata', () => {
    // what_bug_this_catches: held English assistance copy appearing on the Spanish concierge without its required English-only notice.
    expect(source).toContain('const catalogKey = `${value.namespace}.${value.key}`');
    expect(source).toContain('data-catalog-key={catalogKey}');
    expect(source).toContain('data-catalog-render-state={value.renderState}');
    expect(source).toContain('data-catalog-fallback-reason={value.fallbackReason ?? undefined}');
    expect(source).toContain('lang={value.renderedLocale}');
    expect(source).toContain('{value.text}');
    expect(source).toContain('data-catalog-affordance={value.renderState}');
    expect(source).toContain('lang="en">{value.affordance}</small>');
    expect(source).not.toContain('available in English only');
  });

  it('routes each visible human-handoff message through the affordance-aware renderer', () => {
    // what_bug_this_catches: only the page heading displaying fallback metadata while the three held assistance controls silently omit it.
    expect(source).toContain("catalogMessage(locale, 'assistance', 'request.form_heading')");
    expect(source).toContain("catalogMessage(locale, 'assistance', 'request.unassigned_notice')");
    expect(source).toContain("catalogMessage(locale, 'assistance', 'request.send')");
    expect(source).toContain('<Message value={handoffHeading} />');
    expect(source).toContain('<Message value={handoffNotice} />');
    expect(source).toContain('<Message value={handoffLabel} />');
  });

  it('uses English source text plus the resolver affordance for held Spanish assistance values only', () => {
    // what_bug_this_catches: the concierge exposing held Spanish or showing an English-only warning on the English route.
    const keys = ['request.form_heading', 'request.unassigned_notice', 'request.send'] as const;
    for (const key of keys) {
      const english = resolveCatalogMessage({ locale: 'en', namespace: 'assistance', key });
      const spanish = resolveCatalogMessage({ locale: 'es', namespace: 'assistance', key });

      expect(spanish).toMatchObject({
        text: english.text,
        renderedLocale: 'en',
        renderState: 'held_english_fallback',
        fallbackReason: 'critical_not_approved',
        affordance: 'available in English only',
      });
      expect(spanish.affordance).not.toHaveLength(0);
      expect(english.affordance).toBeNull();
      expect(english.renderState).toBe('english_source');
      const spanishDraft = spanishAssistanceDrafts[key];
      expect(spanishDraft).toBeTypeOf('string');
      expect(spanishDraft).not.toBe(spanish.text);
      expect(source).not.toContain(spanishDraft ?? '');
    }
  });

  it('hides chat behind ai_enabled while preserving directory and confirmed handoff controls', () => {
    // what_bug_this_catches: localization wiring accidentally bypassing the AI kill path, directory route, or explicit handoff confirmation.
    expect(source).toContain('conversation.ai_enabled ? <form');
    expect(source).toContain('<a href="/services"><Message value={directoryLabel} /></a>');
    expect(source).toContain('disabled={busy !== null || !confirmed || Boolean(assistance)}');
    expect(source).toContain("fetch('/api/v1/concierge/conversations', { method: 'POST' })");
    expect(source).toContain("fetch(`/api/v1/concierge/conversations/${conversation.id}/handoff`, { method: 'POST' })");
    expect(source).not.toContain('JSON.stringify({ confirmed: true })');
  });
});
