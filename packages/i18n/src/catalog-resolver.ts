export type SupportedCatalogLocale = 'en' | 'es';
export type CatalogDictionary = Readonly<Record<string, string>>;
export type CatalogShape = Readonly<Record<string, CatalogDictionary>>;
export type LocalizedCatalogShape<English extends CatalogShape> = {
  readonly [Namespace in keyof English]: Readonly<Record<Extract<keyof English[Namespace], string>, string>>;
};

export type TranslationReviewStatus = 'draft' | 'awaiting_review' | 'approved' | 'invalidated';
export type ResolutionReviewStatus = TranslationReviewStatus | 'missing' | 'malformed';
export type CatalogFallbackReason =
  | 'critical_not_approved'
  | 'provisional_translation'
  | 'invalidated_translation'
  | 'source_drift'
  | 'missing_metadata'
  | 'malformed_metadata'
  | 'missing_translation'
  | 'unknown_namespace'
  | 'unknown_key'
  | 'unsupported_locale';

export type TranslationStatusEntry = {
  readonly status: TranslationReviewStatus;
  readonly source_version: string;
  readonly critical: boolean;
  readonly machine_generated: boolean;
  readonly render_state?: string;
  readonly reviewed_by?: string;
  readonly reviewer_qualification?: string;
  readonly reviewed_at?: string;
};

export type CatalogSourceBinding = {
  readonly source_version: string;
  readonly source_sha256: string;
};

type FoundResolutionBase = {
  readonly found: true;
  readonly text: string;
  readonly requestedLocale: SupportedCatalogLocale;
  readonly namespace: string;
  readonly key: string;
  readonly critical: boolean;
  readonly machineGenerated: boolean;
};

export type EnglishSourceResolution = FoundResolutionBase & {
  readonly renderState: 'english_source';
  readonly renderedLocale: 'en';
  readonly reviewStatus: ResolutionReviewStatus;
  readonly fallbackReason: null;
  readonly affordance: null;
};

export type ApprovedSpanishResolution = FoundResolutionBase & {
  readonly renderState: 'approved_spanish';
  readonly renderedLocale: 'es';
  readonly reviewStatus: 'approved';
  readonly fallbackReason: null;
  readonly affordance: null;
};

export type HeldCriticalResolution = FoundResolutionBase & {
  readonly renderState: 'held_english_fallback';
  readonly renderedLocale: 'en';
  readonly reviewStatus: 'draft' | 'awaiting_review';
  readonly critical: true;
  readonly fallbackReason: 'critical_not_approved';
  readonly affordance: string;
};

export type ProvisionalFallbackResolution = FoundResolutionBase & {
  readonly renderState: 'provisional_english_fallback';
  readonly renderedLocale: 'en';
  readonly reviewStatus: 'draft' | 'awaiting_review';
  readonly critical: false;
  readonly fallbackReason: 'provisional_translation';
  readonly affordance: string;
};

export type InvalidatedFallbackResolution = FoundResolutionBase & {
  readonly renderState: 'invalidated_english_fallback';
  readonly renderedLocale: 'en';
  readonly reviewStatus: 'invalidated';
  readonly fallbackReason: 'invalidated_translation';
} & (
  | { readonly critical: true; readonly affordance: string }
  | { readonly critical: false; readonly affordance: null }
);

export type SourceDriftFallbackResolution = FoundResolutionBase & {
  readonly renderState: 'source_drift_english_fallback';
  readonly renderedLocale: 'en';
  readonly reviewStatus: ResolutionReviewStatus;
  readonly fallbackReason: 'source_drift';
} & (
  | { readonly critical: true; readonly affordance: string }
  | { readonly critical: false; readonly affordance: null }
);

export type MetadataErrorFallbackResolution = FoundResolutionBase & {
  readonly renderState: 'metadata_error_english_fallback';
  readonly renderedLocale: 'en';
  readonly reviewStatus: 'missing' | 'malformed';
  readonly fallbackReason: 'missing_metadata' | 'malformed_metadata' | 'missing_translation';
} & (
  | { readonly critical: true; readonly affordance: string }
  | { readonly critical: boolean; readonly affordance: null }
);

export type UnknownCatalogResolution = {
  readonly found: false;
  readonly text: '';
  readonly requestedLocale: string;
  readonly renderedLocale: null;
  readonly namespace: string;
  readonly key: string;
  readonly reviewStatus: 'missing';
  readonly critical: false;
  readonly machineGenerated: false;
  readonly renderState: 'unknown_message';
  readonly fallbackReason: 'unknown_namespace' | 'unknown_key' | 'unsupported_locale';
  readonly affordance: null;
};

export type CatalogResolution =
  | EnglishSourceResolution
  | ApprovedSpanishResolution
  | HeldCriticalResolution
  | ProvisionalFallbackResolution
  | InvalidatedFallbackResolution
  | SourceDriftFallbackResolution
  | MetadataErrorFallbackResolution
  | UnknownCatalogResolution;
export type CatalogRenderState = CatalogResolution['renderState'];

export type CatalogResolverBundle<English extends CatalogShape> = {
  readonly catalogs: {
    readonly en: English;
    readonly es: LocalizedCatalogShape<English>;
  };
  readonly statuses: Readonly<Partial<Record<Extract<keyof English, string>, Readonly<Record<string, unknown>>>>>;
  readonly sourceBindings: Readonly<Partial<Record<Extract<keyof English, string>, CatalogSourceBinding>>>;
  readonly criticalFallback: {
    readonly renderState: string;
    readonly affordance: string;
  };
  readonly provisionalAffordance?: string;
};

export type ExtendedCatalogRequest<English extends CatalogShape> = {
  [Namespace in Extract<keyof English, string>]: {
    readonly locale: SupportedCatalogLocale;
    readonly namespace: Namespace;
    readonly key: Extract<keyof English[Namespace], string>;
  };
}[Extract<keyof English, string>];

export type CatalogResolver<English extends CatalogShape> = {
  resolve(input: ExtendedCatalogRequest<English>): CatalogResolution;
};

const SHA256_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, count: number): number {
  return (value >>> count) | (value << (32 - count));
}

export function sha256Utf8(value: string): string {
  const source = new TextEncoder().encode(value);
  const paddedLength = Math.ceil((source.length + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(source);
  bytes[source.length] = 0x80;
  const bitLength = source.length * 8;
  const view = new DataView(bytes.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);
  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const schedule = new Uint32Array(64);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) schedule[index] = view.getUint32(offset + (index * 4));
    for (let index = 16; index < 64; index += 1) {
      const before15 = schedule[index - 15] ?? 0;
      const before2 = schedule[index - 2] ?? 0;
      const sigma0 = rotateRight(before15, 7) ^ rotateRight(before15, 18) ^ (before15 >>> 3);
      const sigma1 = rotateRight(before2, 17) ^ rotateRight(before2, 19) ^ (before2 >>> 10);
      schedule[index] = ((schedule[index - 16] ?? 0) + sigma0 + (schedule[index - 7] ?? 0) + sigma1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const bigSigma1 = rotateRight(e ?? 0, 6) ^ rotateRight(e ?? 0, 11) ^ rotateRight(e ?? 0, 25);
      const choice = ((e ?? 0) & (f ?? 0)) ^ (~(e ?? 0) & (g ?? 0));
      const temporary1 = ((h ?? 0) + bigSigma1 + choice + (SHA256_CONSTANTS[index] ?? 0) + (schedule[index] ?? 0)) >>> 0;
      const bigSigma0 = rotateRight(a ?? 0, 2) ^ rotateRight(a ?? 0, 13) ^ rotateRight(a ?? 0, 22);
      const majority = ((a ?? 0) & (b ?? 0)) ^ ((a ?? 0) & (c ?? 0)) ^ ((b ?? 0) & (c ?? 0));
      const temporary2 = (bigSigma0 + majority) >>> 0;
      h = g; g = f; f = e; e = ((d ?? 0) + temporary1) >>> 0;
      d = c; c = b; b = a; a = (temporary1 + temporary2) >>> 0;
    }
    hash[0] = ((hash[0] ?? 0) + (a ?? 0)) >>> 0;
    hash[1] = ((hash[1] ?? 0) + (b ?? 0)) >>> 0;
    hash[2] = ((hash[2] ?? 0) + (c ?? 0)) >>> 0;
    hash[3] = ((hash[3] ?? 0) + (d ?? 0)) >>> 0;
    hash[4] = ((hash[4] ?? 0) + (e ?? 0)) >>> 0;
    hash[5] = ((hash[5] ?? 0) + (f ?? 0)) >>> 0;
    hash[6] = ((hash[6] ?? 0) + (g ?? 0)) >>> 0;
    hash[7] = ((hash[7] ?? 0) + (h ?? 0)) >>> 0;
  }
  return [...hash].map(value32 => value32.toString(16).padStart(8, '0')).join('');
}

export function serializeCatalog(catalog: CatalogDictionary): string {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}

export function catalogSourceSha256(catalog: CatalogDictionary): string {
  return sha256Utf8(serializeCatalog(catalog));
}

function isObject(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function ownData(value: unknown, key: string): unknown {
  if (!isObject(value)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function ownEntries(value: unknown): ReadonlyArray<readonly [string, unknown]> | null {
  if (!isObject(value)) return null;
  try {
    if (Array.isArray(value)) return null;
    return Object.entries(Object.getOwnPropertyDescriptors(value))
      .filter(([, descriptor]) => descriptor.enumerable && 'value' in descriptor)
      .map(([key, descriptor]) => [key, descriptor.value] as const);
  } catch {
    return null;
  }
}

function frozenDataRecord(value: unknown, mapValue?: (value: unknown) => unknown): Readonly<Record<string, unknown>> | null {
  const entries = ownEntries(value);
  if (entries === null) return null;
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, entry] of entries) result[key] = mapValue === undefined ? entry : mapValue(entry);
  return Object.freeze(result);
}

function snapshotCatalogShape(value: unknown): Readonly<Record<string, CatalogDictionary>> | null {
  const namespaces = ownEntries(value);
  if (namespaces === null) return null;
  const result: Record<string, CatalogDictionary> = Object.create(null) as Record<string, CatalogDictionary>;
  for (const [namespace, catalog] of namespaces) {
    const entries = ownEntries(catalog);
    if (entries === null) continue;
    const copy: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [key, text] of entries) if (typeof text === 'string') copy[key] = text;
    result[namespace] = Object.freeze(copy);
  }
  return Object.freeze(result);
}

function snapshotStatuses(value: unknown): Readonly<Record<string, Readonly<Record<string, unknown>> | null>> | null {
  const namespaces = ownEntries(value);
  if (namespaces === null) return null;
  const result: Record<string, Readonly<Record<string, unknown>> | null> = Object.create(null) as Record<string, Readonly<Record<string, unknown>> | null>;
  for (const [namespace, statusMap] of namespaces) {
    result[namespace] = frozenDataRecord(statusMap, entry => frozenDataRecord(entry));
  }
  return Object.freeze(result);
}

function snapshotBindings(value: unknown): Readonly<Record<string, Readonly<Record<string, unknown>> | null>> | null {
  const namespaces = ownEntries(value);
  if (namespaces === null) return null;
  const result: Record<string, Readonly<Record<string, unknown>> | null> = Object.create(null) as Record<string, Readonly<Record<string, unknown>> | null>;
  for (const [namespace, binding] of namespaces) result[namespace] = frozenDataRecord(binding);
  return Object.freeze(result);
}

type ResolverSnapshot = {
  readonly en: Readonly<Record<string, CatalogDictionary>>;
  readonly es: Readonly<Record<string, CatalogDictionary>> | null;
  readonly statuses: Readonly<Record<string, Readonly<Record<string, unknown>> | null>> | null;
  readonly bindings: Readonly<Record<string, Readonly<Record<string, unknown>> | null>> | null;
  readonly criticalFallback: { readonly renderState: 'held_english_fallback'; readonly affordance: string } | null;
  readonly provisionalAffordance: string;
};

function snapshotBundle(value: unknown): ResolverSnapshot | null {
  const catalogsValue = ownData(value, 'catalogs');
  const en = snapshotCatalogShape(ownData(catalogsValue, 'en'));
  if (en === null) return null;
  const es = snapshotCatalogShape(ownData(catalogsValue, 'es'));
  const statuses = snapshotStatuses(ownData(value, 'statuses'));
  const bindings = snapshotBindings(ownData(value, 'sourceBindings'));
  const criticalValue = ownData(value, 'criticalFallback');
  const renderState = ownData(criticalValue, 'renderState');
  const affordance = ownData(criticalValue, 'affordance');
  const criticalFallback = renderState === 'held_english_fallback' && typeof affordance === 'string' && affordance.length > 0
    ? Object.freeze({ renderState, affordance }) : null;
  const provisional = ownData(value, 'provisionalAffordance');
  return Object.freeze({
    en,
    es,
    statuses,
    bindings,
    criticalFallback,
    provisionalAffordance: typeof provisional === 'string' && provisional.length > 0
      ? provisional : 'Spanish translation is awaiting review.',
  });
}

function hasOwn(value: unknown, key: string): boolean {
  return isObject(value) && Object.hasOwn(value, key);
}

function isStrictUtcTimestamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/u.exec(value);
  if (match === null) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  if (year === undefined || month === undefined || day === undefined || hour === undefined || minute === undefined || second === undefined) return false;
  if (year < 1 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (monthDays[month - 1] ?? 0);
}

function parseStatus(value: unknown): TranslationStatusEntry | null {
  const status = ownData(value, 'status');
  const sourceVersion = ownData(value, 'source_version');
  const critical = ownData(value, 'critical');
  const machineGenerated = ownData(value, 'machine_generated');
  if (typeof status !== 'string' || !['draft', 'awaiting_review', 'approved', 'invalidated'].includes(status)) return null;
  if (typeof sourceVersion !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(sourceVersion)) return null;
  if (typeof critical !== 'boolean' || typeof machineGenerated !== 'boolean') return null;
  const renderState = ownData(value, 'render_state');
  const reviewedBy = ownData(value, 'reviewed_by');
  const qualification = ownData(value, 'reviewer_qualification');
  const reviewedAt = ownData(value, 'reviewed_at');
  for (const optional of [renderState, reviewedBy, qualification, reviewedAt]) {
    if (optional !== undefined && typeof optional !== 'string') return null;
  }
  const evidenceCount = [reviewedBy, qualification, reviewedAt].filter(item => item !== undefined).length;
  const completeEvidence = evidenceCount === 3
    && typeof reviewedBy === 'string' && reviewedBy.trim().length > 0
    && typeof qualification === 'string' && qualification.trim().length > 0
    && typeof reviewedAt === 'string' && isStrictUtcTimestamp(reviewedAt);
  if (status === 'approved' && !completeEvidence) return null;
  if ((status === 'draft' || status === 'awaiting_review') && evidenceCount !== 0) return null;
  if (status === 'invalidated' && evidenceCount !== 0 && !completeEvidence) return null;
  return {
    status: status as TranslationReviewStatus,
    source_version: sourceVersion,
    critical,
    machine_generated: machineGenerated,
    ...(typeof renderState === 'string' ? { render_state: renderState } : {}),
    ...(typeof reviewedBy === 'string' ? { reviewed_by: reviewedBy } : {}),
    ...(typeof qualification === 'string' ? { reviewer_qualification: qualification } : {}),
    ...(typeof reviewedAt === 'string' ? { reviewed_at: reviewedAt } : {}),
  };
}

function unknownResolution(locale: string, namespace: string, key: string, reason: UnknownCatalogResolution['fallbackReason']): UnknownCatalogResolution {
  return {
    found: false, text: '', requestedLocale: locale, renderedLocale: null, namespace, key,
    reviewStatus: 'missing', critical: false, machineGenerated: false,
    renderState: 'unknown_message', fallbackReason: reason, affordance: null,
  };
}

function metadataError(
  common: FoundResolutionBase & { renderedLocale?: never },
  reviewStatus: 'missing' | 'malformed',
  reason: MetadataErrorFallbackResolution['fallbackReason'],
  criticalAffordance: string | null = null,
): MetadataErrorFallbackResolution {
  const base = { ...common, renderedLocale: 'en' as const, reviewStatus, renderState: 'metadata_error_english_fallback' as const, fallbackReason: reason };
  return common.critical && criticalAffordance !== null
    ? { ...base, critical: true, affordance: criticalAffordance }
    : { ...base, affordance: null };
}

export function createCatalogResolver<English extends CatalogShape>(bundle: CatalogResolverBundle<English>): CatalogResolver<English> {
  const snapshot = snapshotBundle(bundle);
  return {
    resolve(input) {
      const unsafeInput = input as unknown;
      const localeValue = ownData(unsafeInput, 'locale');
      const namespaceValue = ownData(unsafeInput, 'namespace');
      const keyValue = ownData(unsafeInput, 'key');
      const locale = typeof localeValue === 'string' ? localeValue : '';
      const namespace = typeof namespaceValue === 'string' ? namespaceValue : '';
      const key = typeof keyValue === 'string' ? keyValue : '';
      if (locale !== 'en' && locale !== 'es') return unknownResolution(locale, namespace, key, 'unsupported_locale');
      if (snapshot === null || !hasOwn(snapshot.en, namespace)) return unknownResolution(locale, namespace, key, 'unknown_namespace');
      const english = ownData(snapshot.en, namespace);
      if (!hasOwn(english, key)) return unknownResolution(locale, namespace, key, 'unknown_key');
      const englishText = ownData(english, key);
      if (typeof englishText !== 'string') return unknownResolution(locale, namespace, key, 'unknown_key');
      const statusMap = snapshot.statuses === null ? null : ownData(snapshot.statuses, namespace);
      const qualifiedKey = `${namespace}.${key}`;
      const rawStatus = statusMap === null || statusMap === undefined ? undefined : ownData(statusMap, qualifiedKey);
      const status = parseStatus(rawStatus);
      const reviewStatus: ResolutionReviewStatus = rawStatus === undefined ? 'missing' : (status?.status ?? 'malformed');
      const common: FoundResolutionBase = {
        found: true, text: englishText, requestedLocale: locale, namespace, key,
        critical: status?.critical ?? false, machineGenerated: status?.machine_generated ?? false,
      };
      if (locale === 'en') {
        return { ...common, renderedLocale: 'en', reviewStatus, renderState: 'english_source', fallbackReason: null, affordance: null };
      }
      if (snapshot.statuses === null || statusMap === null) return metadataError(common, 'malformed', 'malformed_metadata');
      if (rawStatus === undefined) return metadataError(common, 'missing', 'missing_metadata');
      if (status === null) return metadataError(common, 'malformed', 'malformed_metadata');
      if (snapshot.bindings === null || snapshot.criticalFallback === null || snapshot.es === null) {
        return metadataError(common, 'malformed', 'malformed_metadata');
      }
      const binding = ownData(snapshot.bindings, namespace);
      const bindingDigest = ownData(binding, 'source_sha256');
      const bindingVersion = ownData(binding, 'source_version');
      if (typeof bindingDigest !== 'string' || typeof bindingVersion !== 'string') {
        return metadataError(common, 'malformed', 'malformed_metadata');
      }
      const sourceDigest = catalogSourceSha256(english as CatalogDictionary);
      const expectedVersion = `sha256:${sourceDigest}`;
      if (bindingDigest !== sourceDigest || bindingVersion !== expectedVersion || status.source_version !== expectedVersion) {
        const base = {
          ...common, renderedLocale: 'en' as const, reviewStatus: status.status, renderState: 'source_drift_english_fallback' as const,
          fallbackReason: 'source_drift' as const,
        };
        return status.critical
          ? { ...base, critical: true, affordance: snapshot.criticalFallback.affordance }
          : { ...base, critical: false, affordance: null };
      }
      const spanish = ownData(snapshot.es, namespace);
      const spanishText = ownData(spanish, key);
      if (typeof spanishText !== 'string' || spanishText.trim().length === 0) {
        return metadataError(common, 'malformed', 'missing_translation', status.critical ? snapshot.criticalFallback.affordance : null);
      }
      if (status.status === 'approved') {
        return {
          ...common, text: spanishText, renderedLocale: 'es', reviewStatus: 'approved', renderState: 'approved_spanish',
          fallbackReason: null, affordance: null,
        };
      }
      if (status.status === 'invalidated') {
        const base = {
          ...common, renderedLocale: 'en' as const, reviewStatus: 'invalidated' as const, renderState: 'invalidated_english_fallback' as const,
          fallbackReason: 'invalidated_translation' as const,
        };
        return status.critical
          ? { ...base, critical: true, affordance: snapshot.criticalFallback.affordance }
          : { ...base, critical: false, affordance: null };
      }
      if (status.critical) {
        return status.render_state === snapshot.criticalFallback.renderState
          ? {
              ...common, renderedLocale: 'en', reviewStatus: status.status, critical: true, renderState: 'held_english_fallback',
              fallbackReason: 'critical_not_approved', affordance: snapshot.criticalFallback.affordance,
            }
          : metadataError(common, 'malformed', 'malformed_metadata', snapshot.criticalFallback.affordance);
      }
      return {
        ...common, renderedLocale: 'en', reviewStatus: status.status, critical: false,
        renderState: 'provisional_english_fallback', fallbackReason: 'provisional_translation',
        affordance: snapshot.provisionalAffordance,
      };
    },
  };
}
