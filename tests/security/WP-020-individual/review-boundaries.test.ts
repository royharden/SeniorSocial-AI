import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  artifactAad, decryptArtifact, encryptArtifact, InMemoryIndividualExportStore,
  IndividualExportService, MAX_PLAINTEXT_BYTES,
} from '../../../packages/individual-exports/src/index.ts';
import { expectFault, fullRequest, harness, resident, rows, snapshot } from '../../unit/WP-020-individual/fixtures.ts';

describe('WP-020 consequential review regressions', () => {
  it.each(['profile', 'requests', 'proposals', 'audit_events', 'consent_grants'] as const)(
    'rejects duplicate row identities in %s even when counts agree', async (table) => {
      const h = harness();
      const row = rows()[table][0] ?? { id: 'grant-1' };
      h.snapshots.value = snapshot(rows({ [table]: [row, row] }));
      await expectFault(h.makeService().create(resident, fullRequest), 409, 'incomplete_snapshot');
      expect(h.store.readyWrites).toBe(0);
    },
  );

  it('rejects rows with missing selector identities instead of filtering them out', async () => {
    const h = harness();
    h.snapshots.value = snapshot(rows({ audit_events: [
      { id: 'audit-1', resource_id: 'request-1' }, { id: 'audit-2' },
    ] }));
    await expectFault(h.makeService().create(resident, fullRequest), 409, 'incomplete_snapshot');
  });

  it('admits distinct audit events for the same selected resource', async () => {
    const h = harness();
    h.snapshots.value = snapshot(rows({ audit_events: [
      { id: 'audit-1', resource_id: 'request-1' }, { id: 'audit-2', resource_id: 'request-1' },
    ] }));
    expect((await h.makeService().create(resident, fullRequest)).state).toBe('ready');
  });

  it.each([{ requests: [] }, { requests: [{ id: 'unselected-request' }] }])('rejects omitted or substituted selectors even when counts agree: %j', async ({ requests }) => {
    const h = harness();
    h.snapshots.value = snapshot(rows({ requests }));
    await expectFault(h.makeService().create(resident, fullRequest), 409, 'incomplete_snapshot');
    expect(h.store.readyWrites).toBe(0);
  });

  it('rejects an unrequested populated table', async () => {
    const h = harness();
    h.authority.selection = { orgId: resident.orgId, subjectId: resident.userId, profile: true };
    await expectFault(h.makeService().create(resident, { scope: ['profile'], format: 'json' }), 409, 'overbroad_snapshot');
    expect(h.store.readyWrites).toBe(0);
  });

  it('denies revocation at the ready commit boundary without storing an artifact', async () => {
    const h = harness();
    h.store.beforeCommit = () => { h.authority.allowStore = false; };
    await expectFault(h.makeService().create(resident, fullRequest), 404, 'export_unavailable');
    expect(h.store.jobs.get('job-1')?.artifact).toBeUndefined();
    expect(h.store.readyWrites).toBe(0);
  });

  it('denies revocation at the release commit boundary without bytes or audit', async () => {
    const h = harness();
    const service = h.makeService();
    const job = await service.create(resident, fullRequest);
    h.store.beforeRelease = () => { h.authority.allowRelease = false; };
    await expectFault(service.release(resident, job.id), 404, 'export_unavailable');
    expect(h.store.releases).toEqual([]);
  });

  it('keeps expiry opaque to unauthorized staff before any key lookup', async () => {
    const h = harness();
    h.authority.selection = { orgId: resident.orgId, subjectId: resident.userId, requestIds: ['request-1'] };
    h.snapshots.value = snapshot(rows({ profile: [], proposals: [], audit_events: [] }));
    const service = h.makeService();
    const job = await service.create(resident, { scope: ['requests'], format: 'json' });
    h.authority.allowRelease = false;
    h.clock.value = new Date(job.expiresAt);
    h.keys.onRead = () => { throw new Error('must not retrieve keys for denied actors'); };
    await expectFault(service.release({ ...resident, userId: 'staff-other', roles: ['staff'] }, job.id), 404, 'export_unavailable');
    expect(h.store.releases).toEqual([]);
  });

  it('denies expiry during key retrieval and during the release transaction', async () => {
    for (const boundary of ['decrypt', 'transaction']) {
      const h = harness();
      const service = h.makeService();
      const job = await service.create(resident, fullRequest);
      const expire = () => { h.clock.value = new Date(job.expiresAt); };
      if (boundary === 'decrypt') h.keys.onRead = expire;
      else h.store.beforeRelease = expire;
      await expectFault(service.release(resident, job.id), boundary === 'decrypt' ? 410 : 404,
        boundary === 'decrypt' ? 'artifact_expired' : 'export_unavailable');
      expect(h.store.releases).toEqual([]);
    }
  });

  it('authenticates empty artifacts, key versions, and unambiguous AAD with random nonces', async () => {
    const key = randomBytes(32);
    const keys = { current: () => Promise.resolve({ version: 'v1', key }), byVersion: () => Promise.resolve(key) };
    const aad = artifactAad({ orgId: 'a\0b', subjectId: 'c', jobId: 'j', format: 'json' });
    const other = artifactAad({ orgId: 'a', subjectId: 'b\0c', jobId: 'j', format: 'json' });
    expect(aad).not.toEqual(other);
    const first = await encryptArtifact(new Uint8Array(), aad, keys);
    const second = await encryptArtifact(new Uint8Array(), aad, keys);
    expect(first.nonce).toHaveLength(12);
    expect(first.tag).toHaveLength(16);
    expect(first.nonce).not.toEqual(second.nonce);
    expect(await decryptArtifact(first, aad, keys, MAX_PLAINTEXT_BYTES)).toHaveLength(0);
    await expectFault(decryptArtifact({ ...first, keyVersion: 'v2' }, aad, keys, MAX_PLAINTEXT_BYTES), 409, 'artifact_integrity');
    await expectFault(decryptArtifact(first, other, keys, MAX_PLAINTEXT_BYTES), 409, 'artifact_integrity');
    await expectFault(decryptArtifact(first, aad, { ...keys, byVersion: () => Promise.resolve(null) }, MAX_PLAINTEXT_BYTES), 409, 'artifact_integrity');
    const oversized = { ...first, ciphertext: new Uint8Array(MAX_PLAINTEXT_BYTES + 1) };
    await expectFault(decryptArtifact(oversized, aad, keys, MAX_PLAINTEXT_BYTES), 409, 'artifact_integrity');
  });

  it('copies Buffer storage on both input and output and defaults to denying authorization', async () => {
    const h = harness();
    const job = await h.makeService().create(resident, fullRequest);
    const stored = h.store.jobs.get(job.id)!;
    const artifact = { ...stored.artifact!, ciphertext: Buffer.from(stored.artifact!.ciphertext) };
    const memory = new InMemoryIndividualExportStore(() => true, () => h.clock.now());
    await memory.createGenerating({ ...stored.metadata, state: 'generating' });
    expect(await memory.commitReadyIfAuthorized(stored.metadata, artifact, resident)).toBe(true);
    artifact.ciphertext.fill(0);
    const read = (await memory.find(job.id))!;
    expect(read.artifact!.ciphertext).not.toEqual(artifact.ciphertext);
    read.artifact!.ciphertext.fill(0);
    expect((await memory.find(job.id))!.artifact!.ciphertext).not.toEqual(read.artifact!.ciphertext);
    const restarted = new IndividualExportService({ ...h, snapshots: h.snapshots, store: memory });
    expect((await restarted.release(resident, job.id)).bytes.length).toBeGreaterThan(0);
    const denied = new InMemoryIndividualExportStore(undefined, () => h.clock.now());
    await denied.createGenerating({ ...stored.metadata, state: 'generating' });
    expect(await denied.commitReadyIfAuthorized(stored.metadata, artifact, resident)).toBe(false);
  });
});
