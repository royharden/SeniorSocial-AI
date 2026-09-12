import { describe, expect, it } from 'vitest';
import { ARTIFACT_LIFETIME_MS } from '../../../packages/individual-exports/src/index.ts';
import { expectFault, fullRequest, harness, resident } from '../../unit/WP-020-individual/fixtures.ts';

describe('WP-020 durable lifecycle and revoke races', () => {
  it('reauthorizes after snapshot and before atomic ready storage', async () => {
    const h = harness();
    h.authority.allowStore = false;
    await expectFault(h.makeService().create(resident, fullRequest), 404, 'export_unavailable');
    expect(h.authority.phases).toEqual(['store']);
    expect(h.store.readyWrites).toBe(0);
    expect((await h.store.find('job-1'))?.metadata.state).toBe('failed');
  });

  it('survives service restart and expires exactly at 24 hours', async () => {
    const h = harness();
    const job = await h.makeService().create(resident, fullRequest);
    const restarted = h.makeService();
    expect((await restarted.release(resident, job.id)).bytes.byteLength).toBeGreaterThan(0);
    h.clock.value = new Date(Date.parse(job.expiresAt) - 1);
    expect((await restarted.release(resident, job.id)).bytes.byteLength).toBeGreaterThan(0);
    h.clock.value = new Date(Date.parse(job.expiresAt));
    await expectFault(restarted.release(resident, job.id), 410, 'artifact_expired');
    expect(Date.parse(job.expiresAt) - Date.parse('2026-09-10T12:00:00.000Z')).toBe(ARTIFACT_LIFETIME_MS);
  });

  it('denies revoke during decrypt before release audit or returned bytes', async () => {
    const h = harness();
    const service = h.makeService();
    const job = await service.create(resident, fullRequest);
    h.keys.onRead = () => { h.authority.allowRelease = false; };
    await expectFault(service.release(resident, job.id), 404, 'export_unavailable');
    expect(h.authority.phases).toEqual(['store', 'release']);
    expect(h.store.releases).toEqual([]);
  });
});
