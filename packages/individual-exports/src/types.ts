export const exportSections = ['profile', 'requests', 'consents', 'audit', 'proposals'] as const;
export type ExportSection = (typeof exportSections)[number];
export type ExportFormat = 'json' | 'csv';
export type ExportRole = 'senior' | 'caregiver' | 'staff' | 'admin' | 'support' | 'partner';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject { readonly [key: string]: JsonValue }

/** Trusted session projection. None of these fields may come from export request JSON. */
export interface ExportActor {
  readonly orgId: string;
  readonly userId: string;
  readonly roles: readonly ExportRole[];
}

/** The route-level DTO intentionally contains no actor, tenant, subject, or authority claim. */
export interface IndividualExportRequest {
  readonly scope: readonly ExportSection[];
  readonly format: ExportFormat;
}

/** Exact selectors resolved by the server-side authority adapter, never accepted from a client. */
export interface ResolvedExportSelection {
  readonly orgId: string;
  readonly subjectId: string;
  readonly profile?: true;
  readonly requestIds?: readonly string[];
  readonly consents?: true;
  readonly auditResourceIds?: readonly string[];
  readonly proposalIds?: readonly string[];
}

export type AuthorizationPhase = 'store' | 'release';

export interface IndividualExportAuthorityPort {
  resolveSelection(input: {
    readonly actor: ExportActor;
    readonly request: IndividualExportRequest;
  }): Promise<ResolvedExportSelection | null>;
}

export const exportTables = [
  'profile', 'requests', 'consent_grants', 'consent_history',
  'ai_recommendations', 'audit_events', 'proposals',
] as const;
export type ExportTable = (typeof exportTables)[number];

export interface IndividualExportSnapshot {
  /** Captured by the first data query of the repeatable-read transaction. */
  readonly asOf: string;
  readonly sourceVersion: string;
  readonly rows: Readonly<Record<ExportTable, readonly JsonObject[]>>;
  /** Counts must be calculated in the same transaction and are independently verified. */
  readonly counts: Readonly<Record<ExportTable, number>>;
}

export interface IndividualExportSnapshotPort {
  /** One checked-out connection, tenant context, read-only REPEATABLE READ, rows and counts together. */
  readRepeatableReadSnapshot(input: {
    readonly actor: ExportActor;
    readonly selection: ResolvedExportSelection;
    readonly requestedTables: readonly ExportTable[];
  }): Promise<IndividualExportSnapshot>;
}

export interface EncryptedArtifact {
  readonly algorithm: 'aes-256-gcm';
  readonly keyVersion: string;
  readonly nonce: Uint8Array;
  readonly tag: Uint8Array;
  readonly ciphertext: Uint8Array;
}

export interface ExportJobMetadata {
  readonly id: string;
  readonly orgId: string;
  readonly subjectId: string;
  readonly requestedBy: string;
  readonly request: IndividualExportRequest;
  readonly selection: ResolvedExportSelection;
  readonly state: 'generating' | 'ready' | 'failed';
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly asOf?: string;
  readonly sourceVersion?: string;
  readonly plaintextBytes?: number;
  readonly failureCode?: string;
}

export interface StoredExportJob {
  readonly metadata: ExportJobMetadata;
  readonly artifact?: EncryptedArtifact;
}

export interface IndividualExportStorePort {
  createGenerating(metadata: ExportJobMetadata): Promise<void>;
  /** In one durable transaction, lock authority/revocation state, freshly authorize the
   * exact selection for actor, check expiry and generating state, and persist artifact
   * plus ready metadata. Revocation uses the same lock. False commits no artifact.
   * Never implement as a boolean authority lookup followed by a separate write. */
  commitReadyIfAuthorized(metadata: ExportJobMetadata, artifact: EncryptedArtifact, actor: ExportActor): Promise<boolean>;
  markFailed(jobId: string, failureCode: string): Promise<void>;
  /** Actor-scoped lookup: freshly authorize the exact durable selection before returning
   * metadata/artifact; unknown or unauthorized jobs return null, including expired jobs.
   * Does not audit or replace the final atomic release authorization. */
  findAuthorized(jobId: string, actor: ExportActor): Promise<StoredExportJob | null>;
  /** In one durable transaction, lock authority/revocation state, reload this ready job,
   * freshly authorize its exact selection for actor and check expiry using transaction
   * time, then record release. False commits no audit. This is release's linearization
   * point; revocations committed before it deny release, later revocations cannot recall bytes. */
  authorizeReleaseAndRecord(jobId: string, actor: ExportActor, releasedAt: string): Promise<boolean>;
}

export interface ExportEncryptionKeyProvider {
  current(): Promise<{ readonly version: string; readonly key: Uint8Array }>;
  byVersion(version: string): Promise<Uint8Array | null>;
}

export interface ExportClock { now(): Date }
export interface ExportIdGenerator { next(): string }

export interface ReadyIndividualExport {
  readonly id: string;
  readonly state: 'ready';
  readonly scope: readonly ExportSection[];
  readonly format: ExportFormat;
  readonly asOf: string;
  readonly sourceVersion: string;
  readonly expiresAt: string;
  readonly plaintextBytes: number;
  readonly completenessNote: 'complete';
  readonly downloadUrl: null;
}

export interface ReleasedIndividualExport {
  readonly bytes: Uint8Array;
  readonly contentType: 'application/json' | 'application/zip';
  readonly filename: string;
  readonly cacheControl: 'no-store';
}

export class IndividualExportFault extends Error {
  public constructor(
    public readonly status: 404 | 409 | 410 | 422,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'IndividualExportFault';
  }
}
