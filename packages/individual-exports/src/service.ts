import { randomUUID } from 'node:crypto';
import {
  ARTIFACT_LIFETIME_MS, MAX_PLAINTEXT_BYTES, canonicalJson, canonicalPayload,
  requestedTables, validateRequest, validateSelection, validateSnapshot,
} from './canonical.ts';
import { artifactAad, decryptArtifact, encryptArtifact } from './crypto.ts';
import type {
  ExportActor, ExportClock, ExportEncryptionKeyProvider, ExportIdGenerator, ExportJobMetadata,
  IndividualExportAuthorityPort, IndividualExportRequest, IndividualExportSnapshotPort,
  IndividualExportStorePort, ReadyIndividualExport, ReleasedIndividualExport, ResolvedExportSelection,
} from './types.ts';
import { IndividualExportFault } from './types.ts';
import { normalizedCsvZip } from './zip.ts';

export interface IndividualExportServicePorts {
  readonly authority: IndividualExportAuthorityPort;
  readonly snapshots: IndividualExportSnapshotPort;
  readonly store: IndividualExportStorePort;
  readonly keys: ExportEncryptionKeyProvider;
  readonly clock?: ExportClock;
  readonly ids?: ExportIdGenerator;
}

export class IndividualExportService {
  readonly #authority: IndividualExportAuthorityPort;
  readonly #snapshots: IndividualExportSnapshotPort;
  readonly #store: IndividualExportStorePort;
  readonly #keys: ExportEncryptionKeyProvider;
  readonly #clock: ExportClock;
  readonly #ids: ExportIdGenerator;

  public constructor(ports: IndividualExportServicePorts) {
    this.#authority = ports.authority;
    this.#snapshots = ports.snapshots;
    this.#store = ports.store;
    this.#keys = ports.keys;
    this.#clock = ports.clock ?? { now: () => new Date() };
    this.#ids = ports.ids ?? { next: () => randomUUID() };
  }

  public async create(actor: ExportActor, request: IndividualExportRequest): Promise<ReadyIndividualExport> {
    validateRequest(request);
    const trustedActor = copyActor(actor);
    const trustedRequest = copyRequest(request);
    if (!hasAdmissibleRole(trustedActor)) opaqueDenial();
    const resolved = await this.#authority.resolveSelection({ actor: trustedActor, request: trustedRequest });
    if (resolved === null) opaqueDenial();
    const selection = copySelection(resolved);
    validateSelection(trustedRequest, trustedActor.orgId, selection);
    enforceRoleBoundary(trustedActor, selection.subjectId, trustedRequest);

    const now = this.#clock.now();
    const jobId = this.#ids.next();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + ARTIFACT_LIFETIME_MS).toISOString();
    const generating: ExportJobMetadata = {
      id: jobId, orgId: trustedActor.orgId, subjectId: selection.subjectId, requestedBy: trustedActor.userId,
      request: trustedRequest, selection, state: 'generating', createdAt, expiresAt,
    };
    await this.#store.createGenerating(generating);

    let plaintext: Uint8Array | undefined;
    try {
      const tables = requestedTables(trustedRequest.scope);
      const snapshot = await this.#snapshots.readRepeatableReadSnapshot({
        actor: trustedActor, selection, requestedTables: tables,
      });
      validateSnapshot(snapshot, tables, selection);
      const canonical = canonicalPayload({ request: trustedRequest, selection, snapshot, tables });
      plaintext = trustedRequest.format === 'json'
        ? new TextEncoder().encode(canonicalJson(canonical))
        : normalizedCsvZip(canonical);
      if (plaintext.byteLength > MAX_PLAINTEXT_BYTES) {
        throw new IndividualExportFault(422, 'artifact_too_large', 'select fewer resources; export exceeds 5 MiB');
      }
      const aad = artifactAad({
        orgId: trustedActor.orgId, subjectId: selection.subjectId, jobId, format: trustedRequest.format,
      });
      const encrypted = await encryptArtifact(plaintext, aad, this.#keys);
      const ready: ExportJobMetadata = {
        ...generating, state: 'ready', asOf: snapshot.asOf,
        sourceVersion: snapshot.sourceVersion, plaintextBytes: plaintext.byteLength,
      };
      if (!await this.#store.commitReadyIfAuthorized(ready, encrypted, trustedActor)) opaqueDenial();
      return {
        id: jobId, state: 'ready', scope: trustedRequest.scope, format: trustedRequest.format,
        asOf: snapshot.asOf, sourceVersion: snapshot.sourceVersion, expiresAt,
        plaintextBytes: plaintext.byteLength, completenessNote: 'complete', downloadUrl: null,
      };
    } catch (error) {
      const code = error instanceof IndividualExportFault ? error.code : 'generation_failed';
      await this.#store.markFailed(jobId, code);
      throw error;
    } finally {
      plaintext?.fill(0);
    }
  }

  public async release(actor: ExportActor, jobId: string): Promise<ReleasedIndividualExport> {
    const trustedActor = copyActor(actor);
    if (!hasAdmissibleRole(trustedActor)) opaqueDenial();
    const stored = await this.#store.findAuthorized(jobId, trustedActor);
    if (stored === null || stored.metadata.state !== 'ready' || stored.artifact === undefined ||
        stored.metadata.orgId !== trustedActor.orgId) opaqueDenial();
    enforceRoleBoundary(trustedActor, stored.metadata.subjectId, stored.metadata.request);
    if (this.#clock.now().getTime() >= Date.parse(stored.metadata.expiresAt)) {
      throw new IndividualExportFault(410, 'artifact_expired', 'artifact has expired');
    }
    const aad = artifactAad({
      orgId: stored.metadata.orgId, subjectId: stored.metadata.subjectId,
      jobId: stored.metadata.id, format: stored.metadata.request.format,
    });
    const plaintext = await decryptArtifact(stored.artifact, aad, this.#keys, MAX_PLAINTEXT_BYTES);
    if (plaintext.byteLength !== stored.metadata.plaintextBytes) {
      plaintext.fill(0);
      throw new IndividualExportFault(409, 'artifact_integrity', 'artifact length is invalid');
    }
    // Authenticate privately before the atomic authorization/release-record boundary.
    // The adapter checks expiry again with its transaction clock.
    try {
      if (this.#clock.now().getTime() >= Date.parse(stored.metadata.expiresAt)) {
        throw new IndividualExportFault(410, 'artifact_expired', 'artifact has expired');
      }
      if (!await this.#store.authorizeReleaseAndRecord(jobId, trustedActor, this.#clock.now().toISOString())) {
        opaqueDenial();
      }
    } catch (error) {
      plaintext.fill(0);
      throw error;
    }
    const format = stored.metadata.request.format;
    return {
      bytes: plaintext,
      contentType: format === 'json' ? 'application/json' : 'application/zip',
      filename: `individual-export-${jobId}.${format === 'json' ? 'json' : 'zip'}`,
      cacheControl: 'no-store',
    };
  }
}

function copyRequest(request: IndividualExportRequest): IndividualExportRequest {
  return { scope: [...request.scope], format: request.format };
}

function copyActor(actor: ExportActor): ExportActor {
  return { orgId: actor.orgId, userId: actor.userId, roles: [...actor.roles] };
}

function copySelection(selection: ResolvedExportSelection): ResolvedExportSelection {
  return {
    orgId: selection.orgId,
    subjectId: selection.subjectId,
    ...(selection.profile === true ? { profile: true as const } : {}),
    ...(selection.requestIds === undefined ? {} : { requestIds: [...selection.requestIds] }),
    ...(selection.consents === true ? { consents: true as const } : {}),
    ...(selection.auditResourceIds === undefined ? {} : { auditResourceIds: [...selection.auditResourceIds] }),
    ...(selection.proposalIds === undefined ? {} : { proposalIds: [...selection.proposalIds] }),
  };
}

function hasAdmissibleRole(actor: ExportActor): boolean {
  return actor.roles.some((role) => role === 'senior' || role === 'staff');
}

function enforceRoleBoundary(actor: ExportActor, subjectId: string, request: IndividualExportRequest): void {
  if (actor.roles.includes('senior') && actor.userId === subjectId) return;
  const isStaff = actor.roles.includes('staff');
  if (isStaff && request.scope.every((section) => section === 'requests' || section === 'proposals')) return;
  opaqueDenial();
}

function opaqueDenial(): never {
  throw new IndividualExportFault(404, 'export_unavailable', 'export is unavailable');
}
