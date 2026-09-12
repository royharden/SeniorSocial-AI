import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ExportActor } from '../../../packages/individual-exports/src/index.ts';
import { expectFault, fullRequest, harness, resident, rows, snapshot } from '../../unit/WP-020-individual/fixtures.ts';

describe('WP-020 authorization and authenticated release', () => {
  it('enables self-export and opaquely denies other residents, caregivers, and non-staff roles', async () => {
    const denied: ExportActor[] = [
      { orgId: 'org-a', userId: 'other', roles: ['senior'] },
      { orgId: 'org-a', userId: 'caregiver', roles: ['caregiver'] },
      { orgId: 'org-a', userId: 'admin', roles: ['admin'] },
      { orgId: 'org-a', userId: 'support', roles: ['support'] },
    ];
    for (const actor of denied) await expectFault(harness().makeService().create(actor, fullRequest), 404, 'export_unavailable');
    expect((await harness().makeService().create(resident, fullRequest)).state).toBe('ready');
  });

  it('allows staff only exact authorized requests and proposals', async () => {
    const staff: ExportActor = { orgId: 'org-a', userId: 'staff-a', roles: ['staff'] };
    const h = harness();
    h.authority.selection = {
      orgId: 'org-a', subjectId: 'resident-a', requestIds: ['request-1'], proposalIds: ['proposal-1'],
    };
    h.snapshots.value = snapshot(rows({ profile: [], audit_events: [] }));
    expect((await h.makeService().create(staff, { scope: ['requests', 'proposals'], format: 'json' })).state).toBe('ready');
    const denied = harness();
    denied.authority.selection = { orgId: 'org-a', subjectId: 'resident-a', profile: true };
    await expectFault(denied.makeService().create(staff, { scope: ['profile'], format: 'json' }), 404, 'export_unavailable');
  });

  it('returns opaque denial for cross-tenant create and release', async () => {
    const h = harness();
    const ownJob = await h.makeService().create(resident, fullRequest);
    const outsider: ExportActor = { orgId: 'org-b', userId: 'resident-b', roles: ['senior'] };
    h.authority.selection = null;
    await expectFault(h.makeService().create(outsider, fullRequest), 404, 'export_unavailable');
    await expectFault(h.makeService().release(outsider, ownJob.id), 404, 'export_unavailable');
  });

  it.each(['tag', 'nonce', 'ciphertext'] as const)('emits zero release bytes when %s is malformed', async (field) => {
    const h = harness();
    const service = h.makeService();
    const job = await service.create(resident, fullRequest);
    const stored = h.store.jobs.get(job.id)!;
    const artifact = stored.artifact!;
    if (field === 'tag') artifact.tag[0] = (artifact.tag[0] ?? 0) ^ 1;
    if (field === 'nonce') artifact.nonce[0] = (artifact.nonce[0] ?? 0) ^ 1;
    if (field === 'ciphertext') artifact.ciphertext[0] = (artifact.ciphertext[0] ?? 0) ^ 1;
    await expectFault(service.release(resident, job.id), 409, 'artifact_integrity');
    expect(h.store.releases).toEqual([]);
  });

  it('fails closed for wrong key and AAD-bound tenant metadata', async () => {
    const h = harness();
    const service = h.makeService();
    const job = await service.create(resident, fullRequest);
    h.keys.replacement = randomBytes(32);
    await expectFault(service.release(resident, job.id), 409, 'artifact_integrity');
    h.keys.replacement = null;
    const stored = h.store.jobs.get(job.id)!;
    h.store.jobs.set(job.id, { ...stored, metadata: { ...stored.metadata, id: 'tampered-job-id' } });
    await expectFault(service.release(resident, job.id), 409, 'artifact_integrity');
    expect(h.store.releases).toEqual([]);
  });
});
