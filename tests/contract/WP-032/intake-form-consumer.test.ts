import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import enIntake from '../../../packages/i18n/en/intake.json' with { type: 'json' };
import esIntake from '../../../packages/i18n/es/intake.json' with { type: 'json' };
import {
  catalogSourceSha256, createCatalogResolver, resolveCatalogMessage,
} from '../../../packages/i18n/src/catalogs';

const root = resolve(import.meta.dirname, '../../..');
const formPath = resolve(root, 'apps/web/app/(shell)/intake/intake-form.tsx');

describe('WP-032 intake form approval-aware consumer', () => {
  it('binds translated labels to the exact deterministic-routing topic values', async () => {
    // what_bug_this_catches: localization changing the discriminator submitted to routeIntake.
    const source = await readFile(formPath, 'utf8');
    const expected = [
      ['housing', 'topic.legal.housing'],
      ['benefits', 'topic.legal.benefits'],
      ['consumer', 'topic.legal.consumer'],
      ['family', 'topic.legal.family'],
      ['documents', 'topic.legal.documents'],
      ['other', 'topic.legal.other'],
      ['find_care', 'topic.health.find_care'],
      ['appointments', 'topic.health.appointments'],
      ['insurance', 'topic.health.insurance'],
      ['home_support', 'topic.health.home_support'],
      ['prescriptions', 'topic.health.prescriptions'],
      ['other', 'topic.health.other'],
    ] as const;
    for (const [value, key] of expected) expect(source).toContain(`['${value}', '${key}']`);
    expect(source).not.toContain("['medication', 'topic.health.medication']");
    expect(source).not.toContain("['mental_health', 'topic.health.mental_health']");
  });

  it('routes all copy through the resolver and implements one associated ordinary fallback affordance', async () => {
    // what_bug_this_catches: a migrated form retaining inline copy or repeating an English-only notice per field.
    const source = await readFile(formPath, 'utf8');
    expect(source).toContain("from '@seniorsocial/i18n/catalogs'");
    expect(source).toContain("resolveMessage({ locale, namespace: 'intake', key })");
    expect(source).toContain('const ordinaryAffordance = ordinaryValues.find');
    expect(source).toContain('<CatalogAffordance id={ordinaryAffordanceId} value={ordinaryAffordance} />');
    expect(source).toContain('aria-describedby={value.affordance === null ? undefined : affordanceId}');
    expect(source).not.toContain('SeniorSocial and the City are not your lawyer');
  });

  it('holds critical draft Spanish in English and leaves ordinary English source unflagged', () => {
    // what_bug_this_catches: draft legal/medical limitations rendering as approved Spanish or English receiving a false notice.
    const ordinary = resolveCatalogMessage({ locale: 'es', namespace: 'intake', key: 'form.legal_heading' });
    expect(ordinary).toMatchObject({
      renderedLocale: 'en',
      renderState: 'provisional_english_fallback',
      fallbackReason: 'provisional_translation',
    });
    const critical = resolveCatalogMessage({ locale: 'es', namespace: 'intake', key: 'disclaimer.legal' });
    expect(critical).toMatchObject({
      text: 'This form does not create an attorney-client relationship and is not legal advice.',
      renderedLocale: 'en',
      renderState: 'held_english_fallback',
      fallbackReason: 'critical_not_approved',
      affordance: 'available in English only',
    });
    const english = resolveCatalogMessage({ locale: 'en', namespace: 'intake', key: 'disclaimer.legal' });
    expect(english).toMatchObject({ renderState: 'english_source', fallbackReason: null, affordance: null });
  });

  it('renders qualified approved Spanish without a false fallback notice', () => {
    // what_bug_this_catches: the form treating every Spanish request as provisional even after qualified approval.
    const digest = catalogSourceSha256(enIntake);
    const sourceVersion = `sha256:${digest}`;
    const statuses = Object.fromEntries(Object.keys(enIntake).map(key => [`intake.${key}`, {
      status: 'approved', source_version: sourceVersion, critical: key.startsWith('disclaimer.'),
      machine_generated: true, reviewed_by: 'fixture-reviewer',
      reviewer_qualification: 'qualified_spanish_reviewer', reviewed_at: '2026-09-11T12:00:00Z',
    }]));
    const approved = createCatalogResolver({
      catalogs: { en: { intake: enIntake }, es: { intake: esIntake } },
      statuses: { intake: statuses },
      sourceBindings: { intake: { source_sha256: digest, source_version: sourceVersion } },
      criticalFallback: { renderState: 'held_english_fallback', affordance: 'available in English only' },
    });
    for (const key of ['form.legal_heading', 'topic.health.home_support', 'disclaimer.legal'] as const) {
      expect(approved.resolve({ locale: 'es', namespace: 'intake', key })).toMatchObject({
        found: true, renderedLocale: 'es', renderState: 'approved_spanish',
        fallbackReason: null, affordance: null,
      });
    }
  });

  it('guards load and mutation completions with monotonically increasing revisions', async () => {
    // what_bug_this_catches: a slow GET or failed earlier mutation overwriting the newest form state/status.
    const source = await readFile(formPath, 'utf8');
    expect(source).toContain('const mutationRevision = useRef(0)');
    expect(source.match(/const revision = \+\+mutationRevision\.current;/gu)).toHaveLength(2);
    expect(source.match(/revision !== mutationRevision\.current/gu)).toHaveLength(2);
    expect(source).toContain('if (revision === mutationRevision.current) setStatus');
    expect(source).toContain('if (revision === mutationRevision.current) setBusy(false)');
  });
});
