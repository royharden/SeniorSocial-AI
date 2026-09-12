import { randomBytes } from 'node:crypto';
import type {
  AuthorizationPhase, EncryptedArtifact, ExportActor, ExportClock, ExportEncryptionKeyProvider,
  ExportJobMetadata, ExportTable, IndividualExportAuthorityPort, IndividualExportRequest,
  IndividualExportSnapshot, IndividualExportSnapshotPort, IndividualExportStorePort, JsonObject,
  ResolvedExportSelection, StoredExportJob,
} from '../../../packages/individual-exports/src/index.ts';
import { IndividualExportService, exportTables } from '../../../packages/individual-exports/src/index.ts';

export const resident: ExportActor = { orgId: 'org-a', userId: 'resident-a', roles: ['senior'] };
export const fullRequest: IndividualExportRequest = {
  scope: ['profile', 'requests', 'consents', 'audit', 'proposals'], format: 'json',
};
export const fullSelection: ResolvedExportSelection = {
  orgId: 'org-a', subjectId: 'resident-a', profile: true, requestIds: ['request-1'],
  consents: true, auditResourceIds: ['request-1'], proposalIds: ['proposal-1'],
};

export function rows(overrides: Partial<Record<ExportTable, readonly JsonObject[]>> = {}): Record<ExportTable, readonly JsonObject[]> {
  return {
    profile: [{ id: 'resident-a', display_name: 'Ana' }],
    requests: [{ id: 'request-1', state: 'open', source_refs: ['notice-1'] }],
    consent_grants: [], consent_history: [], ai_recommendations: [],
    audit_events: [{ id: 'audit-1', resource_id: 'request-1' }],
    proposals: [{ id: 'proposal-1', state: 'submitted', source_version: 3 }],
    ...overrides,
  };
}

export function snapshot(tableRows = rows()): IndividualExportSnapshot {
  return {
    asOf: '2026-09-10T12:00:00.000Z', sourceVersion: 'db:42', rows: tableRows,
    counts: Object.fromEntries(exportTables.map((table) => [table, tableRows[table].length])) as Record<ExportTable, number>,
  };
}

export class FakeAuthority implements IndividualExportAuthorityPort {
  public selection: ResolvedExportSelection | null = fullSelection;
  public allowStore = true;
  public allowRelease = true;
  public readonly phases: AuthorizationPhase[] = [];
  public resolveSelection(): Promise<ResolvedExportSelection | null> { return Promise.resolve(this.selection); }
}

export class FakeSnapshots implements IndividualExportSnapshotPort {
  public value = snapshot();
  public calls = 0;
  public requestedTables: readonly ExportTable[] = [];
  public readRepeatableReadSnapshot(input: { requestedTables: readonly ExportTable[] }): Promise<IndividualExportSnapshot> {
    this.calls += 1;
    this.requestedTables = input.requestedTables;
    return Promise.resolve(this.value);
  }
}

export class MutableClock implements ExportClock {
  public value = new Date('2026-09-10T12:00:00.000Z');
  public now(): Date { return new Date(this.value); }
}

export class FakeKeys implements ExportEncryptionKeyProvider {
  public readonly key = randomBytes(32);
  public replacement: Uint8Array | null = null;
  public onRead: (() => void) | undefined;
  public current(): Promise<{ version: string; key: Uint8Array }> { return Promise.resolve({ version: 'v1', key: this.key }); }
  public byVersion(): Promise<Uint8Array | null> {
    this.onRead?.();
    return Promise.resolve(this.replacement ?? this.key);
  }
}

export class InspectableStore implements IndividualExportStorePort {
  public constructor(private readonly authority: FakeAuthority, private readonly clock: MutableClock) {}
  public beforeCommit: (() => void) | undefined;
  public beforeRelease: (() => void) | undefined;
  public readonly jobs = new Map<string, StoredExportJob>();
  public readonly releases: string[] = [];
  public readyWrites = 0;
  public createGenerating(metadata: ExportJobMetadata): Promise<void> {
    this.jobs.set(metadata.id, { metadata: structuredClone(metadata) });
    return Promise.resolve();
  }
  public commitReadyIfAuthorized(metadata: ExportJobMetadata, artifact: EncryptedArtifact): Promise<boolean> {
    this.beforeCommit?.();
    this.authority.phases.push('store');
    if (!this.authority.allowStore || this.clock.now().getTime() >= Date.parse(metadata.expiresAt)) return Promise.resolve(false);
    this.readyWrites += 1;
    this.jobs.set(metadata.id, { metadata: structuredClone(metadata), artifact: cloneArtifact(artifact) });
    return Promise.resolve(true);
  }
  public markFailed(jobId: string, failureCode: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (job !== undefined) this.jobs.set(jobId, { metadata: { ...job.metadata, state: 'failed', failureCode } });
    return Promise.resolve();
  }
  public find(jobId: string): Promise<StoredExportJob | null> { return Promise.resolve(this.jobs.get(jobId) ?? null); }
  public findAuthorized(jobId: string): Promise<StoredExportJob | null> {
    return this.authority.allowRelease ? this.find(jobId) : Promise.resolve(null);
  }
  public authorizeReleaseAndRecord(jobId: string): Promise<boolean> {
    this.beforeRelease?.();
    this.authority.phases.push('release');
    const job = this.jobs.get(jobId);
    if (!this.authority.allowRelease || job?.metadata.state !== 'ready' ||
        this.clock.now().getTime() >= Date.parse(job.metadata.expiresAt)) return Promise.resolve(false);
    this.releases.push(jobId);
    return Promise.resolve(true);
  }
}

export function harness() {
  const authority = new FakeAuthority();
  const snapshots = new FakeSnapshots();
  const keys = new FakeKeys();
  const clock = new MutableClock();
  const store = new InspectableStore(authority, clock);
  let id = 0;
  const makeService = () => new IndividualExportService({
    authority, snapshots, store, keys, clock, ids: { next: () => `job-${++id}` },
  });
  return { authority, snapshots, store, keys, clock, makeService };
}

export async function expectFault(promise: Promise<unknown>, status: number, code: string): Promise<void> {
  await promise.then(
    () => { throw new Error('expected rejection'); },
    (error: unknown) => {
      if (!(error instanceof Error) || !('status' in error) || !('code' in error)) throw error;
      if (error.status !== status || error.code !== code) throw error;
    },
  );
}

function cloneArtifact(artifact: EncryptedArtifact): EncryptedArtifact {
  return { ...artifact, nonce: Uint8Array.from(artifact.nonce), tag: Uint8Array.from(artifact.tag), ciphertext: Uint8Array.from(artifact.ciphertext) };
}
