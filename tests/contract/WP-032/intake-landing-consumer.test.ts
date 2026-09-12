import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveCatalogMessage } from '../../../packages/i18n/src/catalogs';

const root = resolve(import.meta.dirname, '../../..');

describe('WP-032 intake landing approval-aware consumer', () => {
  it('routes every landing message and the critical health limitation through the public resolver', async () => {
    // what_bug_this_catches: removing a stale consumer finding while landing copy still bypasses review state.
    const source = await readFile(resolve(root, 'apps/web/app/(shell)/intake/page.tsx'), 'utf8');
    expect(source).toContain("from '@seniorsocial/i18n/catalogs'");
    expect(source).toContain('resolveCatalogMessage');
    for (const key of [
      'landing.title', 'landing.intro', 'landing.legal_heading', 'landing.legal_description',
      'landing.legal_start', 'landing.health_heading', 'landing.health_description',
      'landing.health_start', 'disclaimer.health',
    ]) expect(source).toContain(`'${key}'`);
    expect(source).not.toContain('Find the right kind of help');
    expect(source).not.toContain('does not provide medical advice');
    // what_bug_this_catches: a browser-test seam becoming an unsupported Next page runtime export.
    expect(source).not.toContain('export function IntakeLanding');
  });

  it('renders resolver language, state and associated affordance metadata generically', async () => {
    // what_bug_this_catches: correct resolver output being flattened back into unlabelled text at the consumer.
    const source = await readFile(resolve(root, 'apps/web/app/(shell)/intake/page.tsx'), 'utf8');
    expect(source).toContain('lang={value.renderedLocale}');
    expect(source).toContain('data-catalog-render-state={value.renderState}');
    expect(source).toContain('data-catalog-fallback-reason={value.fallbackReason ?? undefined}');
    expect(source).toContain('aria-describedby={value.affordance === null ? undefined : messageId(value)}');
    expect(source).toContain('data-catalog-affordance={value.renderState}');
    expect(source).toContain('>{value.affordance}</p>');
  });

  it('holds unapproved critical Spanish in governed English and leaves English source unflagged', () => {
    // what_bug_this_catches: draft Spanish medical limitations becoming public or English source receiving a false notice.
    const held = resolveCatalogMessage({ locale: 'es', namespace: 'intake', key: 'disclaimer.health' });
    expect(held).toMatchObject({
      found: true,
      text: 'This form is not medical advice, diagnosis, treatment, or emergency care.',
      renderedLocale: 'en',
      renderState: 'held_english_fallback',
      fallbackReason: 'critical_not_approved',
      affordance: 'available in English only',
    });
    expect(held.text).not.toContain('Este formulario');

    const english = resolveCatalogMessage({ locale: 'en', namespace: 'intake', key: 'disclaimer.health' });
    expect(english).toMatchObject({
      renderedLocale: 'en', renderState: 'english_source', fallbackReason: null, affordance: null,
    });
  });

  it('preserves legal and health destinations without eligibility or professional-service claims', async () => {
    // what_bug_this_catches: localization changing navigation or adding a service/eligibility promise.
    const source = await readFile(resolve(root, 'apps/web/app/(shell)/intake/page.tsx'), 'utf8');
    expect(source).toContain('href="/intake/legal"');
    expect(source).toContain('href="/intake/health"');
    expect(source.toLowerCase()).not.toContain('eligib');
    expect(source).not.toContain('medical advice provided');
    expect(source).not.toContain('legal advice provided');
  });
});
