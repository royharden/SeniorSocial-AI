import { describe, expect, it, vi } from 'vitest';
import { createRagService, type RagRepository } from '../../../packages/rag/src/index.ts';

const orgA = '11111111-1111-4111-8111-111111111111';
const orgB = '22222222-2222-4222-8222-222222222222';
const userA = '11111111-1111-4111-8111-111111111101';
const requestId = '11111111-1111-4111-8111-111111111191';

describe('WP-023 tenant and poisoning boundaries', () => {
  // what_bug_this_catches: poisoned non-finite similarity scores propagate into JSON or ranking decisions.
  it('sanitizes non-finite repository scores at the repository boundary', async () => {
    const source = await import('../../../packages/rag/src/repository.ts');
    const repository = source.createRagRepository(async (_orgId, work) => work({
      query: async <T>() => [
        { service_id: '11111111-1111-4111-8111-111111111151', score: Number.POSITIVE_INFINITY },
        { service_id: '11111111-1111-4111-8111-111111111152', score: -20 },
      ] as T[],
    }));
    expect(await repository.hybrid(orgA, 'meal', 'en', [1, 2], 2, 5)).toEqual([
      { service_id: '11111111-1111-4111-8111-111111111151', score: 0 },
      { service_id: '11111111-1111-4111-8111-111111111152', score: 0 },
    ]);
  });

  // what_bug_this_catches: the caller org is omitted from hybrid retrieval and another tenant's citable id is disclosed.
  it('passes authenticated org scope through every retrieval boundary', async () => {
    const hybrid = vi.fn<RagRepository['hybrid']>().mockImplementation(async orgId => orgId === orgA
      ? [{ service_id: '11111111-1111-4111-8111-111111111151', score: 0.5 }] : []);
    const service = createRagService({ flags: { effective: vi.fn().mockResolvedValue(true) },
      gateway: { embed: vi.fn().mockResolvedValue({ outcome: 'ok', vectors: [[1, 2]], dimensions: 2, model: 'stub' }) },
      fts: { search: vi.fn().mockResolvedValue({ items: [] }) },
      jobs: { resolveService: vi.fn().mockResolvedValue({ orgId: orgA, gatewayUserId: userA }) },
      repository: { prepare: vi.fn(), replace: vi.fn(), hybrid } as unknown as RagRepository });
    await expect(service.search({ orgId: orgA, userId: userA, requestId, userRole: 'senior', locale: 'en', query: 'meal' }))
      .resolves.toEqual({ items: [{ service_id: '11111111-1111-4111-8111-111111111151', score: 0.5 }] });
    expect(hybrid).toHaveBeenCalledWith(orgA, 'meal', 'en', [1, 2], 2, 10);
    expect(hybrid).not.toHaveBeenCalledWith(orgB, expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything());
  });

  // what_bug_this_catches: forged tenant/actor fields in the public job payload select another organisation before trusted resolution.
  it('rejects unknown job fields and hides unresolved service ids before storage or embedding', async () => {
    const gateway = { embed: vi.fn() }; const prepare = vi.fn();
    const jobs = { resolveService: vi.fn().mockResolvedValue(null) };
    const service = createRagService({ flags: { effective: vi.fn() }, gateway, jobs,
      fts: { search: vi.fn() }, repository: { prepare, replace: vi.fn(), hybrid: vi.fn() } as unknown as RagRepository });
    await expect(service.reindex({ service_id: '11111111-1111-4111-8111-111111111151', idempotency_key: 'missing' }))
      .resolves.toEqual({ outcome: 'missing' });
    await expect(service.reindex({ service_id: '11111111-1111-4111-8111-111111111151', idempotency_key: 'forged',
      org_id: orgB } as never)).rejects.toThrow('unknown fields');
    expect(jobs.resolveService).toHaveBeenCalledExactlyOnceWith('11111111-1111-4111-8111-111111111151');
    expect(gateway.embed).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
  });
});
