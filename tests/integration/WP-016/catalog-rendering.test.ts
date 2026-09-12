import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type * as ReactDOMServer from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CatalogAffordance, ResolvedText } from '../../../apps/web/app/(shell)/messages/CatalogText';
import { catalogSourceSha256, createCatalogResolver } from '../../../packages/i18n/src/catalogs';

// Resolve the rendering runtime from the app that owns these components.
const appRequire = createRequire(resolve('apps/web/package.json'));
const { renderToStaticMarkup } = appRequire('react-dom/server') as typeof ReactDOMServer;
const english = { 'report.saved': 'Report saved for human review.' };
const digest = catalogSourceSha256(english);
const sourceVersion = `sha256:${digest}`;
function resolver(status: unknown, spanish = 'Reporte guardado para revisión humana.') {
  return createCatalogResolver({
    catalogs: { en: { messages: english }, es: { messages: { 'report.saved': spanish } } },
    statuses: { messages: { 'messages.report.saved': status } },
    sourceBindings: { messages: { source_version: sourceVersion, source_sha256: digest } },
    criticalFallback: { renderState: 'held_english_fallback', affordance: 'available in English only' },
  });
}
const held = {
  status: 'awaiting_review', source_version: sourceVersion, critical: true,
  machine_generated: true, render_state: 'held_english_fallback',
};

describe('WP-016 catalog components render the resolver decision', () => {
  it('renders approved Spanish without a hold or provisional claim', () => {
    // what_bug_this_catches: a consumer continuing to display English after qualified approval.
    const resolution = resolver({ ...held, status: 'approved', reviewed_by: 'reviewer',
      reviewer_qualification: 'qualified bilingual reviewer', reviewed_at: '2026-09-10T00:00:00Z',
    }).resolve({ locale: 'es', namespace: 'messages', key: 'report.saved' });
    expect(resolution.renderState).toBe('approved_spanish');
    expect(renderToStaticMarkup(ResolvedText({ resolution }))).toContain('lang="es"');
    expect(renderToStaticMarkup(ResolvedText({ resolution }))).toContain(resolution.text);
    expect(renderToStaticMarkup(CatalogAffordance({ resolution }))).toBe('');
  });

  it.each([
    [held, 'held_english_fallback'],
    [{ ...held, status: 'invalidated' }, 'invalidated_english_fallback'],
    [{ ...held, source_version: `sha256:${'0'.repeat(64)}` }, 'source_drift_english_fallback'],
    [{ ...held, render_state: 'wrong' }, 'metadata_error_english_fallback'],
    [{ ...held, critical: false }, 'provisional_english_fallback'],
  ])('renders fail-safe text and every supplied affordance (%j)', (status, expectedState) => {
    // what_bug_this_catches: fallback UI losing its availability notice or language tag.
    const resolution = resolver(status).resolve({ locale: 'es', namespace: 'messages', key: 'report.saved' });
    expect(resolution.renderState).toBe(expectedState);
    const text = renderToStaticMarkup(ResolvedText({ resolution }));
    expect(text).toContain('lang="en"');
    expect(text).toContain(english['report.saved']);
    expect(text).not.toContain('Reporte');
    expect(resolution.affordance).not.toBeNull();
    const affordance = renderToStaticMarkup(CatalogAffordance({ resolution }));
    expect(affordance).toContain('lang="en"');
    expect(affordance).toContain(resolution.affordance!);
  });

  it('does not invent an approval or affordance for malformed metadata', () => {
    // what_bug_this_catches: treating an unknown review status as approved or provisional.
    const resolution = resolver({ status: 'unrecognized' }).resolve({ locale: 'es', namespace: 'messages', key: 'report.saved' });
    expect(resolution.renderState).toBe('metadata_error_english_fallback');
    expect(resolution.affordance).toBeNull();
    expect(renderToStaticMarkup(ResolvedText({ resolution }))).toContain(english['report.saved']);
    expect(renderToStaticMarkup(CatalogAffordance({ resolution }))).toBe('');
  });
});
