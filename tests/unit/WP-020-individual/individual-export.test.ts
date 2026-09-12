import { describe, expect, it } from 'vitest';
import type { CanonicalIndividualExport } from '../../../packages/individual-exports/src/index.ts';
import { MAX_PLAINTEXT_BYTES } from '../../../packages/individual-exports/src/index.ts';
import { expectFault, fullRequest, harness, resident, rows, snapshot } from './fixtures.ts';

describe('WP-020 individual export generation', () => {
  it('emits every admitted section with exact empty arrays and snapshot counts', async () => {
    const h = harness();
    const job = await h.makeService().create(resident, fullRequest);
    const released = await h.makeService().release(resident, job.id);
    const payload = JSON.parse(new TextDecoder().decode(released.bytes)) as unknown as CanonicalIndividualExport;
    expect(h.snapshots.calls).toBe(1);
    expect(h.snapshots.requestedTables).toEqual([
      'profile', 'requests', 'consent_grants', 'consent_history',
      'ai_recommendations', 'audit_events', 'proposals',
    ]);
    expect(payload.manifest.scope).toEqual(fullRequest.scope);
    expect(payload.manifest.excludedSections).toEqual([]);
    expect(payload.manifest.counts).toEqual({
      profile: 1, requests: 1, consent_grants: 0, consent_history: 0,
      ai_recommendations: 0, audit_events: 1, proposals: 1,
    });
    expect(payload.tables.consent_grants).toEqual([]);
    expect(payload.tables.consent_history).toEqual([]);
    expect(payload.tables.ai_recommendations).toEqual([]);
    expect(job.downloadUrl).toBeNull();
  });

  it('rejects selector/section mismatch and duplicate or excessive explicit resources', async () => {
    const h = harness();
    const { proposalIds: _omitted, ...withoutProposalSelector } = h.authority.selection!;
    h.authority.selection = withoutProposalSelector;
    await expectFault(h.makeService().create(resident, fullRequest), 422, 'selector_mismatch');
    h.authority.selection = { orgId: 'org-a', subjectId: 'resident-a', requestIds: Array.from({ length: 51 }, (_, i) => `r-${i}`) };
    await expectFault(h.makeService().create(resident, { scope: ['requests'], format: 'json' }), 422, 'resource_limit');
    h.authority.selection = { orgId: 'org-a', subjectId: 'resident-a', requestIds: ['same', 'same'] };
    await expectFault(h.makeService().create(resident, { scope: ['requests'], format: 'json' }), 422, 'selector_mismatch');

    const atLimit = harness();
    const ids = Array.from({ length: 50 }, (_, i) => `r-${i}`);
    atLimit.authority.selection = { orgId: 'org-a', subjectId: 'resident-a', requestIds: ids };
    atLimit.snapshots.value = snapshot(rows({
      profile: [], requests: ids.map((id) => ({ id })), audit_events: [], proposals: [],
    }));
    expect((await atLimit.makeService().create(
      resident, { scope: ['requests'], format: 'json' },
    )).state).toBe('ready');
  });

  it('fails rather than labelling mismatched same-snapshot counts complete', async () => {
    const h = harness();
    h.snapshots.value = { ...snapshot(), counts: { ...snapshot().counts, requests: 0 } };
    await expectFault(h.makeService().create(resident, fullRequest), 409, 'incomplete_snapshot');
    expect(h.store.readyWrites).toBe(0);
  });

  it('rejects a plaintext over 5 MiB without truncation or a ready artifact', async () => {
    const h = harness();
    h.authority.selection = { orgId: 'org-a', subjectId: 'resident-a', profile: true };
    h.snapshots.value = snapshot(rows({
      profile: [{ id: 'resident-a', body: 'x'.repeat(MAX_PLAINTEXT_BYTES) }],
      requests: [], audit_events: [], proposals: [],
    }));
    await expectFault(h.makeService().create(resident, { scope: ['profile'], format: 'json' }), 422, 'artifact_too_large');
    expect(h.store.readyWrites).toBe(0);
    expect((await h.store.find('job-1'))?.metadata.failureCode).toBe('artifact_too_large');
  });
});
