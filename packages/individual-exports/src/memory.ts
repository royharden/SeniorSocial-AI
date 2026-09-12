import type {
  AuthorizationPhase, EncryptedArtifact, ExportActor, ExportJobMetadata, IndividualExportStorePort, StoredExportJob,
} from './types.ts';

/** Test/demo adapter. Production composition should implement the same port with PostgreSQL bytea. */
export class InMemoryIndividualExportStore implements IndividualExportStorePort {
  readonly #jobs = new Map<string, StoredExportJob>();
  public readonly releases: { jobId: string; actorId: string; at: string }[] = [];

  /** Synchronous test policy only: no await may split policy evaluation and mutation.
   * Default deny prevents this demo adapter from accidentally granting production access. */
  public constructor(
    private readonly authorize: (actor: ExportActor, metadata: ExportJobMetadata, phase: AuthorizationPhase) => boolean = () => false,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public createGenerating(metadata: ExportJobMetadata): Promise<void> {
    if (this.#jobs.has(metadata.id)) throw new Error('duplicate export job');
    this.#jobs.set(metadata.id, { metadata: structuredClone(metadata) });
    return Promise.resolve();
  }

  public commitReadyIfAuthorized(metadata: ExportJobMetadata, artifact: EncryptedArtifact, actor: ExportActor): Promise<boolean> {
    if (this.#jobs.get(metadata.id)?.metadata.state !== 'generating' ||
        !(this.now().getTime() < Date.parse(metadata.expiresAt)) ||
        !this.authorize(actor, structuredClone(metadata), 'store')) return Promise.resolve(false);
    this.#jobs.set(metadata.id, { metadata: structuredClone(metadata), artifact: cloneArtifact(artifact) });
    return Promise.resolve(true);
  }

  public markFailed(jobId: string, failureCode: string): Promise<void> {
    const current = this.#jobs.get(jobId);
    if (current === undefined) return Promise.resolve();
    this.#jobs.set(jobId, {
      metadata: { ...structuredClone(current.metadata), state: 'failed', failureCode },
    });
    return Promise.resolve();
  }

  public find(jobId: string): Promise<StoredExportJob | null> {
    const stored = this.#jobs.get(jobId);
    if (stored === undefined) return Promise.resolve(null);
    return Promise.resolve({
      metadata: structuredClone(stored.metadata),
      ...(stored.artifact === undefined ? {} : { artifact: cloneArtifact(stored.artifact) }),
    });
  }

  public findAuthorized(jobId: string, actor: ExportActor): Promise<StoredExportJob | null> {
    const stored = this.#jobs.get(jobId);
    if (stored === undefined || stored.metadata.orgId !== actor.orgId ||
        !this.authorize(actor, structuredClone(stored.metadata), 'release')) return Promise.resolve(null);
    return this.find(jobId);
  }

  public authorizeReleaseAndRecord(jobId: string, actor: ExportActor, releasedAt: string): Promise<boolean> {
    const stored = this.#jobs.get(jobId);
    if (stored?.metadata.state !== 'ready' || stored.artifact === undefined ||
        !(this.now().getTime() < Date.parse(stored.metadata.expiresAt)) ||
        !this.authorize(actor, structuredClone(stored.metadata), 'release')) return Promise.resolve(false);
    this.releases.push({ jobId, actorId: actor.userId, at: releasedAt });
    return Promise.resolve(true);
  }
}

function cloneArtifact(artifact: EncryptedArtifact): EncryptedArtifact {
  return {
    ...artifact,
    nonce: Uint8Array.from(artifact.nonce),
    tag: Uint8Array.from(artifact.tag),
    ciphertext: Uint8Array.from(artifact.ciphertext),
  };
}
