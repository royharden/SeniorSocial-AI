import { describe, expect, it } from 'vitest';
import {
  catalogSourceSha256,
  createCatalogResolver,
  sha256Utf8,
  type CatalogResolverBundle,
  type CatalogResolution,
  type TranslationStatusEntry,
} from '../../../packages/i18n/src/catalog-resolver';

const english = {
  sample: {
    ordinary: 'Hello, {name}.',
    critical: 'Call 911 now.',
  },
} as const;
const spanish = {
  sample: {
    ordinary: 'Hola, {name}.',
    critical: 'Llame al 911 ahora.',
  },
} as const;
const digest = catalogSourceSha256(english.sample);
const version = `sha256:${digest}`;
type UnsafeResolver = { resolve(input: unknown): CatalogResolution };
const unsafeCreate = createCatalogResolver as unknown as (input: unknown) => UnsafeResolver;

function status(overrides: Partial<TranslationStatusEntry> = {}): TranslationStatusEntry {
  return {
    status: 'draft',
    source_version: version,
    critical: false,
    machine_generated: true,
    ...overrides,
  };
}

function bundle(
  entry: unknown = status(),
  overrides: Partial<CatalogResolverBundle<typeof english>> = {},
): CatalogResolverBundle<typeof english> {
  return {
    catalogs: { en: english, es: spanish },
    statuses: { sample: { 'sample.ordinary': entry, 'sample.critical': entry } },
    sourceBindings: { sample: { source_sha256: digest, source_version: version } },
    criticalFallback: { renderState: 'held_english_fallback', affordance: 'available in English only' },
    ...overrides,
  };
}

describe('WP-032 approval-aware catalog resolver', () => {
  it('uses a browser-safe UTF-8 SHA-256 implementation', () => {
    // what_bug_this_catches: a browser bundle depending on Node crypto or hashing UTF-16 code units.
    expect(sha256Utf8('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Utf8('Sí')).toBe('739215889580345e7630a71acd2863cd8ffd6db4bca79a39d1a276b8b3bcec6a');
  });

  it('returns English directly and handles unknown namespaces and keys safely at runtime', () => {
    // what_bug_this_catches: unsafe indexing throwing or exposing undefined when untyped input crosses a JS boundary.
    const resolver = createCatalogResolver(bundle());
    expect(resolver.resolve({ locale: 'en', namespace: 'sample', key: 'ordinary' })).toMatchObject({
      found: true, text: 'Hello, {name}.', renderedLocale: 'en', renderState: 'english_source', fallbackReason: null,
    });
    const unsafeResolve = resolver.resolve as (input: { locale: 'en' | 'es'; namespace: string; key: string }) => unknown;
    expect(unsafeResolve({ locale: 'es', namespace: 'missing', key: 'ordinary' })).toMatchObject({
      found: false, text: '', renderState: 'unknown_message', fallbackReason: 'unknown_namespace',
    });
    expect(unsafeResolve({ locale: 'es', namespace: 'sample', key: 'missing' })).toMatchObject({
      found: false, text: '', renderState: 'unknown_message', fallbackReason: 'unknown_key',
    });
  });

  it('renders qualified approved Spanish without treating machine provenance as disqualifying', () => {
    // what_bug_this_catches: machine-assisted copy remaining held after an authorized qualified human approval.
    const approved = status({
      status: 'approved', machine_generated: true, reviewed_by: 'reviewer-1',
      reviewer_qualification: 'qualified_spanish_reviewer', reviewed_at: '2026-09-10T20:00:00Z',
    });
    const result = createCatalogResolver(bundle(approved)).resolve({ locale: 'es', namespace: 'sample', key: 'ordinary' });
    expect(result).toMatchObject({
      text: 'Hola, {name}.', renderedLocale: 'es', reviewStatus: 'approved', machineGenerated: true,
      renderState: 'approved_spanish', fallbackReason: null,
    });
    expect(result.text).toContain('{name}');
  });

  it('contrasts a held critical built-in shape with the same copy after qualified approval', () => {
    // what_bug_this_catches: tests proving only approval or only critical hold, without proving the review transition changes the render decision.
    const held = status({ critical: true, render_state: 'held_english_fallback' });
    expect(createCatalogResolver(bundle(held)).resolve({ locale: 'es', namespace: 'sample', key: 'critical' })).toMatchObject({
      text: 'Call 911 now.', renderedLocale: 'en', reviewStatus: 'draft', critical: true,
      renderState: 'held_english_fallback', fallbackReason: 'critical_not_approved',
      affordance: 'available in English only',
    });
    const approved = status({
      status: 'approved', critical: true, machine_generated: true,
      reviewed_by: 'reviewer-1', reviewer_qualification: 'qualified_spanish_reviewer',
      reviewed_at: '2026-09-10T20:00:00Z',
    });
    expect(createCatalogResolver(bundle(approved)).resolve({ locale: 'es', namespace: 'sample', key: 'critical' })).toMatchObject({
      text: 'Llame al 911 ahora.', renderedLocale: 'es', reviewStatus: 'approved', critical: true,
      machineGenerated: true, renderState: 'approved_spanish', fallbackReason: null, affordance: null,
    });
  });

  it('fails approved metadata without complete valid reviewer evidence safely to English', () => {
    // what_bug_this_catches: status=approved alone bypassing qualified-review evidence validation.
    const result = createCatalogResolver(bundle(status({ status: 'approved' }))).resolve({ locale: 'es', namespace: 'sample', key: 'ordinary' });
    expect(result).toMatchObject({
      text: 'Hello, {name}.', renderedLocale: 'en', reviewStatus: 'malformed',
      renderState: 'metadata_error_english_fallback', fallbackReason: 'malformed_metadata',
    });
  });

  it('retains complete invalidated review evidence but never renders the invalidated translation', () => {
    // what_bug_this_catches: retained audit evidence being mistaken for a still-current approval.
    const invalidated = status({
      status: 'invalidated', reviewed_by: 'reviewer-1', reviewer_qualification: 'qualified_spanish_reviewer',
      reviewed_at: '2026-09-10T20:00:00Z',
    });
    expect(createCatalogResolver(bundle(invalidated)).resolve({ locale: 'es', namespace: 'sample', key: 'ordinary' })).toMatchObject({
      text: 'Hello, {name}.', reviewStatus: 'invalidated', renderState: 'invalidated_english_fallback',
      fallbackReason: 'invalidated_translation',
    });
  });

  it('distinguishes source drift and SHA binding corruption from review-state fallbacks', () => {
    // what_bug_this_catches: valid-looking approvals surviving an English source edit or poisoned policy digest.
    const approved = status({
      status: 'approved', reviewed_by: 'reviewer-1', reviewer_qualification: 'qualified_spanish_reviewer',
      reviewed_at: '2026-09-10T20:00:00Z',
    });
    const staleStatus = { ...approved, source_version: `sha256:${'0'.repeat(64)}` };
    expect(createCatalogResolver(bundle(staleStatus)).resolve({ locale: 'es', namespace: 'sample', key: 'ordinary' })).toMatchObject({
      renderState: 'source_drift_english_fallback', fallbackReason: 'source_drift', renderedLocale: 'en',
    });
    const corruptBinding = { sample: { source_sha256: '0'.repeat(64), source_version: `sha256:${'0'.repeat(64)}` } };
    expect(createCatalogResolver(bundle(approved, { sourceBindings: corruptBinding })).resolve({ locale: 'es', namespace: 'sample', key: 'ordinary' })).toMatchObject({
      renderState: 'source_drift_english_fallback', fallbackReason: 'source_drift', renderedLocale: 'en',
    });
  });

  it('holds critical drafts even with manual provenance and labels ordinary provisional states truthfully', () => {
    // what_bug_this_catches: manual provenance being treated as approval or ordinary review queues being labeled critical.
    const critical = status({ critical: true, machine_generated: false, render_state: 'held_english_fallback' });
    expect(createCatalogResolver(bundle(critical)).resolve({ locale: 'es', namespace: 'sample', key: 'critical' })).toMatchObject({
      text: 'Call 911 now.', critical: true, machineGenerated: false, renderState: 'held_english_fallback',
      fallbackReason: 'critical_not_approved', affordance: 'available in English only',
    });
    for (const reviewStatus of ['draft', 'awaiting_review'] as const) {
      const provisional = status({ status: reviewStatus, machine_generated: reviewStatus === 'draft' });
      expect(createCatalogResolver(bundle(provisional)).resolve({ locale: 'es', namespace: 'sample', key: 'ordinary' })).toMatchObject({
        text: 'Hello, {name}.', reviewStatus, renderedLocale: 'en', renderState: 'provisional_english_fallback',
        fallbackReason: 'provisional_translation', affordance: 'Spanish translation is awaiting review.',
      });
    }
  });

  it('fails missing metadata safely and never returns Spanish', () => {
    // what_bug_this_catches: a new key becoming implicitly publishable because its status sidecar entry is absent.
    const missing = bundle();
    const resolver = createCatalogResolver({ ...missing, statuses: { sample: {} } });
    expect(resolver.resolve({ locale: 'es', namespace: 'sample', key: 'ordinary' })).toMatchObject({
      text: 'Hello, {name}.', renderedLocale: 'en', reviewStatus: 'missing',
      renderState: 'metadata_error_english_fallback', fallbackReason: 'missing_metadata',
    });
  });

  it('supports a typed extension namespace for the forthcoming messages catalog', () => {
    // what_bug_this_catches: D1 needing to fork approval semantics instead of extending the shared resolver bundle.
    const messagesEn = { messages: { inbox_title: 'Messages' } } as const;
    const messagesEs = { messages: { inbox_title: 'Mensajes' } } as const;
    const messagesDigest = catalogSourceSha256(messagesEn.messages);
    const messagesVersion = `sha256:${messagesDigest}`;
    const resolver = createCatalogResolver({
      catalogs: { en: messagesEn, es: messagesEs },
      statuses: { messages: { 'messages.inbox_title': {
        status: 'approved', source_version: messagesVersion, critical: false, machine_generated: true,
        reviewed_by: 'reviewer-1', reviewer_qualification: 'qualified_spanish_reviewer', reviewed_at: '2026-09-10T20:00:00Z',
      } } },
      sourceBindings: { messages: { source_sha256: messagesDigest, source_version: messagesVersion } },
      criticalFallback: { renderState: 'held_english_fallback', affordance: 'available in English only' },
    });
    expect(resolver.resolve({ locale: 'es', namespace: 'messages', key: 'inbox_title' })).toMatchObject({
      text: 'Mensajes', renderedLocale: 'es', reviewStatus: 'approved', machineGenerated: true,
    });
  });

  it('rejects unsupported locales and empty approved Spanish deterministically', () => {
    // what_bug_this_catches: an untyped locale being treated as Spanish or an empty approved value erasing visible copy.
    const approved = status({
      status: 'approved', reviewed_by: 'reviewer-1', reviewer_qualification: 'qualified_spanish_reviewer',
      reviewed_at: '2026-09-10T20:00:00Z',
    });
    const resolver = unsafeCreate(bundle(approved));
    expect(resolver.resolve({ locale: 'fr', namespace: 'sample', key: 'ordinary' })).toMatchObject({
      found: false, text: '', renderedLocale: null, renderState: 'unknown_message', fallbackReason: 'unsupported_locale',
    });
    for (const empty of ['', '   ', '\t', '\n\r']) {
      const emptySpanish = bundle(approved, { catalogs: { en: english, es: { sample: { ordinary: empty, critical: empty } } } });
      expect(createCatalogResolver(emptySpanish).resolve({ locale: 'es', namespace: 'sample', key: 'ordinary' })).toMatchObject({
        text: 'Hello, {name}.', renderedLocale: 'en', renderState: 'metadata_error_english_fallback',
        fallbackReason: 'missing_translation',
      });
    }
  });

  it('accepts strict UTC RFC3339 review times and rejects impossible calendar dates', () => {
    // what_bug_this_catches: Date.parse normalizing February 30 into a different day while approval still succeeds.
    for (const reviewedAt of ['2024-02-29T23:59:59Z', '2026-09-10T20:00:00.123456789Z']) {
      const approved = status({
        status: 'approved', reviewed_by: 'reviewer-1', reviewer_qualification: 'qualified_spanish_reviewer', reviewed_at: reviewedAt,
      });
      expect(createCatalogResolver(bundle(approved)).resolve({ locale: 'es', namespace: 'sample', key: 'ordinary' }).renderState).toBe('approved_spanish');
    }
    for (const reviewedAt of [
      '2023-02-29T12:00:00Z', '2024-02-30T12:00:00Z', '2024-13-01T12:00:00Z',
      '2024-01-01T24:00:00Z', '2024-01-01T12:60:00Z', '2024-01-01T12:00:60Z',
      '2024-01-01T12:00:00+00:00', '2024-01-01T12:00:00',
    ]) {
      const approved = status({
        status: 'approved', reviewed_by: 'reviewer-1', reviewer_qualification: 'qualified_spanish_reviewer', reviewed_at: reviewedAt,
      });
      expect(createCatalogResolver(bundle(approved)).resolve({ locale: 'es', namespace: 'sample', key: 'ordinary' })).toMatchObject({
        renderedLocale: 'en', reviewStatus: 'malformed', fallbackReason: 'malformed_metadata',
      });
    }
  });

  it('requires own properties throughout approval metadata and Spanish catalogs', () => {
    // what_bug_this_catches: prototype pollution supplying review evidence, bindings, or Spanish text that authorizes rendering.
    const approved = status({
      status: 'approved', reviewed_by: 'reviewer-1', reviewer_qualification: 'qualified_spanish_reviewer',
      reviewed_at: '2026-09-10T20:00:00Z',
    });
    const base = bundle(approved);
    const inheritedNamespace = Object.create({ sample: { 'sample.ordinary': approved } }) as object;
    const inheritedQualifiedKey = Object.create({ 'sample.ordinary': approved }) as object;
    const inheritedStatus = Object.create(approved) as object;
    const inheritedEvidence = Object.assign(Object.create({
      reviewed_by: 'reviewer-1', reviewer_qualification: 'qualified_spanish_reviewer', reviewed_at: '2026-09-10T20:00:00Z',
    }) as object, { status: 'approved', source_version: version, critical: false, machine_generated: true });
    const inheritedBinding = Object.create({ source_sha256: digest, source_version: version }) as object;
    const inheritedSpanishNamespace = Object.create({ sample: spanish.sample }) as object;
    const inheritedSpanishKey = Object.create({ ordinary: spanish.sample.ordinary, critical: spanish.sample.critical }) as object;
    const inheritedCriticalPolicy = Object.create({ renderState: 'held_english_fallback', affordance: 'available in English only' }) as object;
    const attacks: unknown[] = [
      { ...base, statuses: inheritedNamespace },
      { ...base, statuses: { sample: inheritedQualifiedKey } },
      { ...base, statuses: { sample: { 'sample.ordinary': inheritedStatus } } },
      { ...base, statuses: { sample: { 'sample.ordinary': inheritedEvidence } } },
      { ...base, sourceBindings: { sample: inheritedBinding } },
      { ...base, catalogs: { en: english, es: inheritedSpanishNamespace } },
      { ...base, catalogs: { en: english, es: { sample: inheritedSpanishKey } } },
      { ...base, criticalFallback: inheritedCriticalPolicy },
    ];
    for (const attack of attacks) {
      const result = unsafeCreate(attack).resolve({ locale: 'es', namespace: 'sample', key: 'ordinary' });
      expect(result.renderedLocale).not.toBe('es');
      expect(result.renderState).not.toBe('approved_spanish');
    }
  });

  it('fails malformed containers and policy closed without throwing', () => {
    // what_bug_this_catches: null configuration causing a request-time exception or invalid policy allowing approved Spanish.
    const approved = status({
      status: 'approved', reviewed_by: 'reviewer-1', reviewer_qualification: 'qualified_spanish_reviewer',
      reviewed_at: '2026-09-10T20:00:00Z',
    });
    const base = bundle(approved);
    const malformed: unknown[] = [
      { ...base, statuses: null },
      { ...base, statuses: { sample: null } },
      { ...base, sourceBindings: null },
      { ...base, sourceBindings: { sample: null } },
      { ...base, criticalFallback: null },
      { ...base, catalogs: { en: english, es: null } },
    ];
    for (const candidate of malformed) {
      expect(() => unsafeCreate(candidate).resolve({ locale: 'es', namespace: 'sample', key: 'ordinary' })).not.toThrow();
      expect(unsafeCreate(candidate).resolve({ locale: 'es', namespace: 'sample', key: 'ordinary' })).toMatchObject({
        text: 'Hello, {name}.', renderedLocale: 'en', renderState: 'metadata_error_english_fallback',
      });
    }
    expect(unsafeCreate(null).resolve({ locale: 'es', namespace: 'sample', key: 'ordinary' })).toMatchObject({
      found: false, renderedLocale: null, renderState: 'unknown_message', fallbackReason: 'unknown_namespace',
    });
  });

  it('snapshots and freezes caller data without invoking accessors', () => {
    // what_bug_this_catches: post-construction mutation or a getter changing a previously validated approval decision.
    const mutableEnglish = { sample: { ordinary: 'Hello, {name}.', critical: 'Call 911 now.' } };
    const mutableSpanish = { sample: { ordinary: 'Hola, {name}.', critical: 'Llame al 911 ahora.' } };
    const mutableDigest = catalogSourceSha256(mutableEnglish.sample);
    const mutableVersion = `sha256:${mutableDigest}`;
    const mutableStatus = {
      status: 'approved', source_version: mutableVersion, critical: false, machine_generated: true,
      reviewed_by: 'reviewer-1', reviewer_qualification: 'qualified_spanish_reviewer', reviewed_at: '2026-09-10T20:00:00Z',
    };
    const mutableBinding = { source_sha256: mutableDigest, source_version: mutableVersion };
    const mutablePolicy = { renderState: 'held_english_fallback', affordance: 'available in English only' };
    const caller = {
      catalogs: { en: mutableEnglish, es: mutableSpanish }, statuses: { sample: { 'sample.ordinary': mutableStatus } },
      sourceBindings: { sample: mutableBinding }, criticalFallback: mutablePolicy,
    };
    const resolver = unsafeCreate(caller);
    mutableEnglish.sample.ordinary = 'Changed English';
    mutableSpanish.sample.ordinary = 'Español cambiado';
    mutableStatus.status = 'draft';
    mutableBinding.source_sha256 = '0'.repeat(64);
    mutablePolicy.renderState = 'broken';
    mutablePolicy.affordance = 'changed';
    expect(resolver.resolve({ locale: 'es', namespace: 'sample', key: 'ordinary' })).toMatchObject({
      text: 'Hola, {name}.', renderedLocale: 'es', renderState: 'approved_spanish', reviewStatus: 'approved',
    });

    let getterCalls = 0;
    const withGetter = { ...caller } as Record<string, unknown>;
    Object.defineProperty(withGetter, 'statuses', { enumerable: true, get: () => { getterCalls += 1; return caller.statuses; } });
    expect(unsafeCreate(withGetter).resolve({ locale: 'es', namespace: 'sample', key: 'ordinary' }).renderedLocale).not.toBe('es');
    expect(getterCalls).toBe(0);
    const hostile = new Proxy({}, { getOwnPropertyDescriptor: () => { throw new Error('blocked'); } });
    expect(() => unsafeCreate(hostile).resolve({ locale: 'es', namespace: 'sample', key: 'ordinary' })).not.toThrow();
  });

  it('rejects non-primitive status values without coercion or exceptions', () => {
    // what_bug_this_catches: String(status) invoking attacker-controlled coercion while resolving a catalog message.
    const throwing = { toString: () => { throw new Error('must not run'); } };
    for (const statusValue of [throwing, null, new String('approved')]) {
      const malformed = { ...status(), status: statusValue };
      const resolver = unsafeCreate(bundle(malformed));
      expect(() => resolver.resolve({ locale: 'es', namespace: 'sample', key: 'ordinary' })).not.toThrow();
      expect(resolver.resolve({ locale: 'es', namespace: 'sample', key: 'ordinary' })).toMatchObject({
        renderedLocale: 'en', reviewStatus: 'malformed', renderState: 'metadata_error_english_fallback',
        fallbackReason: 'malformed_metadata',
      });
      expect(resolver.resolve({ locale: 'en', namespace: 'sample', key: 'ordinary' })).toMatchObject({
        renderedLocale: 'en', reviewStatus: 'malformed', renderState: 'english_source', fallbackReason: null,
      });
    }
  });

  it('contains revoked proxies in every caller-controlled container', () => {
    // what_bug_this_catches: Array.isArray or descriptor inspection on a revoked proxy escaping as a request-time exception.
    const approved = status({
      status: 'approved', reviewed_by: 'reviewer-1', reviewer_qualification: 'qualified_spanish_reviewer',
      reviewed_at: '2026-09-10T20:00:00Z',
    });
    const base = bundle(approved);
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const candidates: unknown[] = [
      { ...base, statuses: revoked.proxy },
      { ...base, statuses: { sample: revoked.proxy } },
      { ...base, sourceBindings: revoked.proxy },
      { ...base, sourceBindings: { sample: revoked.proxy } },
      { ...base, catalogs: revoked.proxy },
      { ...base, catalogs: { en: english, es: revoked.proxy } },
      { ...base, criticalFallback: revoked.proxy },
    ];
    for (const candidate of candidates) {
      expect(() => {
        const resolver = unsafeCreate(candidate);
        resolver.resolve({ locale: 'es', namespace: 'sample', key: 'ordinary' });
      }).not.toThrow();
    }
  });

  it('keeps the English-only affordance on every trusted critical fallback', () => {
    // what_bug_this_catches: a critical fallback losing the notice that Spanish is unavailable while retaining a trusted critical flag.
    const evidence = {
      reviewed_by: 'reviewer-1', reviewer_qualification: 'qualified_spanish_reviewer', reviewed_at: '2026-09-10T20:00:00Z',
    };
    const invalidated = status({ status: 'invalidated', critical: true, ...evidence });
    expect(createCatalogResolver(bundle(invalidated)).resolve({ locale: 'es', namespace: 'sample', key: 'critical' })).toMatchObject({
      critical: true, renderState: 'invalidated_english_fallback', fallbackReason: 'invalidated_translation',
      affordance: 'available in English only',
    });
    const stale = status({ critical: true, source_version: `sha256:${'0'.repeat(64)}`, render_state: 'held_english_fallback' });
    expect(createCatalogResolver(bundle(stale)).resolve({ locale: 'es', namespace: 'sample', key: 'critical' })).toMatchObject({
      critical: true, renderState: 'source_drift_english_fallback', fallbackReason: 'source_drift',
      affordance: 'available in English only',
    });
    const approved = status({ status: 'approved', critical: true, ...evidence });
    const whitespaceSpanish = bundle(approved, { catalogs: { en: english, es: { sample: { ordinary: 'Hola', critical: ' \t\n ' } } } });
    expect(createCatalogResolver(whitespaceSpanish).resolve({ locale: 'es', namespace: 'sample', key: 'critical' })).toMatchObject({
      critical: true, renderState: 'metadata_error_english_fallback', fallbackReason: 'missing_translation',
      affordance: 'available in English only',
    });
    const malformedHold = status({ critical: true, machine_generated: false });
    expect(createCatalogResolver(bundle(malformedHold)).resolve({ locale: 'es', namespace: 'sample', key: 'critical' })).toMatchObject({
      critical: true, renderState: 'metadata_error_english_fallback', fallbackReason: 'malformed_metadata',
      affordance: 'available in English only',
    });
  });
});
