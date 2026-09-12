import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveCatalogMessage, type CatalogMessageRequest } from '../../../packages/i18n/src/catalogs.ts';

const root = resolve(import.meta.dirname, '../../..');
const intakeForm = readFileSync(resolve(root, 'apps/web/app/(shell)/intake/intake-form.tsx'), 'utf8');
const criticalKeys = [
  'disclaimer.legal',
  'disclaimer.health',
  'disclaimer.legal_ack',
  'disclaimer.health_ack',
  'disclaimer.urgent_heading',
  'disclaimer.urgent_body',
  'disclaimer.call_911',
  'disclaimer.call_988',
  'disclaimer.talk_person',
  'disclaimer.important_heading',
  'disclaimer.save_without_ack',
] as const satisfies ReadonlyArray<CatalogMessageRequest<'intake'>['key']>;

describe('WP-033 intake critical-copy containment', () => {
  it.each(criticalKeys)('%s remains held in English until qualified Spanish approval', key => {
    // what_bug_this_catches: provisional legal, medical, or crisis copy is rendered as
    // approved Spanish despite the catalog metadata requiring an English-only hold.
    const english = resolveCatalogMessage({ locale: 'en', namespace: 'intake', key });
    const spanishRequest = resolveCatalogMessage({ locale: 'es', namespace: 'intake', key });

    expect(spanishRequest).toMatchObject({
      found: true,
      critical: true,
      renderedLocale: 'en',
      renderState: 'held_english_fallback',
      fallbackReason: 'critical_not_approved',
      affordance: 'available in English only',
      text: english.text,
    });
  });

  it('routes every critical intake surface through the public catalog resolver', () => {
    // what_bug_this_catches: the form bypasses review status with a local bilingual
    // disclaimer or acknowledgement even though the catalog resolver is fail-closed.
    expect(intakeForm).toContain("from '@seniorsocial/i18n/catalogs'");
    expect(intakeForm).toContain("namespace: 'intake'");
    for (const key of criticalKeys) expect(intakeForm).toContain(`'${key}'`);
    expect(intakeForm).not.toMatch(/copy\.(?:en|es)\[kind\]\.disclaimer/u);
    expect(intakeForm).not.toMatch(/formText\.acknowledge/u);
    expect(intakeForm).not.toContain('<p lang="es">');
  });
});
