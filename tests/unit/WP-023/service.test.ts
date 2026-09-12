import { describe, expect, it, vi } from 'vitest';
import { createRagService, type RagRepository } from '../../../packages/rag/src/index.ts';

const ids = {
  org: '11111111-1111-4111-8111-111111111111', user: '11111111-1111-4111-8111-111111111101',
  request: '11111111-1111-4111-8111-111111111191', service: '11111111-1111-4111-8111-111111111151',
};
const request = { orgId: ids.org, userId: ids.user, userRole: 'senior' as const, requestId: ids.request,
  locale: 'en' as const, query: 'meal delivery', limit: 5 };
const jobs = { resolveService: vi.fn().mockResolvedValue({ orgId: ids.org, gatewayUserId: ids.user }) };

function repository(overrides: Partial<RagRepository> = {}): RagRepository {
  return {
    prepare: vi.fn().mockResolvedValue(null), replace: vi.fn().mockResolvedValue('indexed'),
    hybrid: vi.fn().mockResolvedValue([{ service_id: ids.service, score: 0.75 }]), ...overrides,
  };
}

describe('RAG orchestration', () => {
  // what_bug_this_catches: a disabled quality flag still leaks query text to an embedding provider.
  it('returns the exact FTS response shape with zero embedding calls when disabled', async () => {
    const gateway = { embed: vi.fn() };
    const fts = { search: vi.fn().mockResolvedValue({ items: [{ id: ids.service }] }) };
    const service = createRagService({ flags: { effective: vi.fn().mockResolvedValue(false) }, gateway, fts,
      repository: repository(), jobs });
    await expect(service.search(request)).resolves.toEqual({ items: [{ service_id: ids.service, score: 1 }] });
    expect(gateway.embed).not.toHaveBeenCalled();
  });

  // what_bug_this_catches: RAG invents an unsupported gateway feature or exposes model text in retrieval output.
  it('calls only AiGateway.embed with concierge and returns citable ids plus numeric scores', async () => {
    const gateway = { embed: vi.fn().mockResolvedValue({ outcome: 'ok', vectors: [[0.2, 0.4]], dimensions: 2,
      model: 'test-stub' }) };
    const service = createRagService({ flags: { effective: vi.fn().mockResolvedValue(true) }, gateway,
      fts: { search: vi.fn() }, repository: repository(), jobs });
    const result = await service.search(request);
    expect(gateway.embed).toHaveBeenCalledWith(expect.objectContaining({ feature: 'concierge', inputs: ['meal delivery'] }));
    expect(result).toEqual({ items: [{ service_id: ids.service, score: 0.75 }] });
    expect(Object.keys(result.items[0] ?? {})).toEqual(['service_id', 'score']);
  });

  // what_bug_this_catches: killed/error/malformed embeddings escape instead of preserving directory search.
  it.each([
    { outcome: 'killed', vectors: [], dimensions: 0, model: 'stub' },
    { outcome: 'error', vectors: [], dimensions: 0, model: 'stub' },
    { outcome: 'ok', vectors: [[Number.NaN, 1]], dimensions: 2, model: 'stub' },
    { outcome: 'ok', vectors: [[1]], dimensions: 2, model: 'stub' },
    { outcome: 'ok', vectors: [[0, 0]], dimensions: 2, model: 'stub' },
  ])('falls back for $outcome or an invalid vector', async embedding => {
    const fts = { search: vi.fn().mockResolvedValue({ items: [{ id: ids.service }] }) };
    const service = createRagService({ flags: { effective: vi.fn().mockResolvedValue(true) },
      gateway: { embed: vi.fn().mockResolvedValue(embedding) }, fts, repository: repository(), jobs });
    await expect(service.search(request)).resolves.toEqual({ items: [{ service_id: ids.service, score: 1 }] });
    expect(fts.search).toHaveBeenCalledOnce();
  });

  // what_bug_this_catches: an empty query wastes an embedding call or unbounded inputs/results reach infrastructure.
  it('bounds query/results and sends empty queries directly to FTS', async () => {
    const gateway = { embed: vi.fn() }; const fts = { search: vi.fn().mockResolvedValue({ items: [] }) };
    const service = createRagService({ flags: { effective: vi.fn().mockResolvedValue(true) }, gateway, fts,
      repository: repository(), jobs });
    await expect(service.search({ ...request, query: '   ' })).resolves.toEqual({ items: [] });
    expect(gateway.embed).not.toHaveBeenCalled();
    await expect(service.search({ ...request, query: 'x'.repeat(513) })).rejects.toThrow('512');
    await expect(service.search({ ...request, limit: 51 })).rejects.toThrow('50');
  });

  // what_bug_this_catches: a pg-boss retry spends twice and rewrites the same service embedding.
  it('makes rag.reindex idempotent before calling the gateway', async () => {
    const gateway = { embed: vi.fn() };
    const service = createRagService({ flags: { effective: vi.fn().mockResolvedValue(true) }, gateway,
      fts: { search: vi.fn() }, jobs, repository: repository({ prepare: vi.fn().mockResolvedValue({ serviceId: ids.service,
        content: 'Meals', contentVersion: '2026-09-10T12:00:00.000Z', contentFingerprint: 'a'.repeat(32),
        alreadyProcessed: true }) }) });
    await expect(service.reindex({ service_id: ids.service, idempotency_key: 'service.updated:1' }))
      .resolves.toEqual({ outcome: 'duplicate' });
    expect(gateway.embed).not.toHaveBeenCalled();
  });

  // what_bug_this_catches: the flag-gated job path embeds content even though interactive retrieval is disabled.
  it('makes rag.reindex a zero-embed no-op when disabled', async () => {
    const gateway = { embed: vi.fn() }; const repo = repository({ prepare: vi.fn() });
    const service = createRagService({ flags: { effective: vi.fn().mockResolvedValue(false) }, gateway,
      fts: { search: vi.fn() }, repository: repo, jobs });
    await expect(service.reindex({ service_id: ids.service, idempotency_key: 'service.updated:disabled' }))
      .resolves.toEqual({ outcome: 'disabled' });
    expect(gateway.embed).not.toHaveBeenCalled();
    expect(repo.prepare).not.toHaveBeenCalled();
  });

  // what_bug_this_catches: concurrent delivery of the same pg-boss job starts two paid embedding calls before DB idempotency can act.
  it('coalesces concurrent identical reindex work before embedding', async () => {
    let finishEmbed: ((value: { outcome: 'ok'; vectors: number[][]; dimensions: number; model: string }) => void) | undefined;
    const embedResult = new Promise<{ outcome: 'ok'; vectors: number[][]; dimensions: number; model: string }>(resolve => {
      finishEmbed = resolve;
    });
    const gateway = { embed: vi.fn().mockReturnValue(embedResult) };
    const repo = repository({ prepare: vi.fn().mockResolvedValue({ serviceId: ids.service, content: 'Meals',
      contentVersion: '2026-09-10T12:00:00.000000Z', contentFingerprint: 'a'.repeat(32), alreadyProcessed: false }) });
    const service = createRagService({ flags: { effective: vi.fn().mockResolvedValue(true) }, gateway,
      fts: { search: vi.fn() }, repository: repo, jobs });
    const job = { service_id: ids.service, idempotency_key: 'service.updated:concurrent' };
    const first = service.reindex(job); const second = service.reindex(job);
    await vi.waitFor(() => expect(gateway.embed).toHaveBeenCalledOnce());
    finishEmbed?.({ outcome: 'ok', vectors: [[1, 2]], dimensions: 2, model: 'stub' });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { outcome: 'indexed', service_id: ids.service }, { outcome: 'indexed', service_id: ids.service },
    ]);
    expect(repo.prepare).toHaveBeenCalledOnce(); expect(repo.replace).toHaveBeenCalledOnce();
    expect(gateway.embed).toHaveBeenCalledWith(expect.objectContaining({ context: expect.objectContaining({
      userId: ids.user, requestId: expect.stringMatching(/^rag-reindex:[0-9a-f]{64}$/u),
    }) }));
  });

  // what_bug_this_catches: blank or oversized model identifiers reach persistence after provider spend.
  it.each([' ', 'm'.repeat(201)])('rejects invalid model identifier %j before replacement', async model => {
    const repo = repository({ prepare: vi.fn().mockResolvedValue({ serviceId: ids.service, content: 'Meals',
      contentVersion: '2026-09-10T12:00:00.000000Z', contentFingerprint: 'a'.repeat(32), alreadyProcessed: false }) });
    const service = createRagService({ flags: { effective: vi.fn().mockResolvedValue(true) }, jobs,
      gateway: { embed: vi.fn().mockResolvedValue({ outcome: 'ok', vectors: [[1, 2]], dimensions: 2, model }) },
      fts: { search: vi.fn() }, repository: repo });
    await expect(service.reindex({ service_id: ids.service, idempotency_key: `model:${model.length}` }))
      .resolves.toEqual({ outcome: 'fallback', reason: 'invalid_vector' });
    expect(repo.replace).not.toHaveBeenCalled();
  });

  // what_bug_this_catches: a directory edit racing an embedding request installs a stale vector.
  it('reports stale when the repository rejects a raced replacement', async () => {
    const repo = repository({ prepare: vi.fn().mockResolvedValue({ serviceId: ids.service, content: 'Meals',
      contentVersion: '2026-09-10T12:00:00.000Z', contentFingerprint: 'a'.repeat(32), alreadyProcessed: false }),
      replace: vi.fn().mockResolvedValue('stale') });
    const service = createRagService({ flags: { effective: vi.fn().mockResolvedValue(true) },
      gateway: { embed: vi.fn().mockResolvedValue({ outcome: 'ok', vectors: [[1, 2]], dimensions: 2, model: 'stub' }) },
      fts: { search: vi.fn() }, repository: repo, jobs });
    await expect(service.reindex({ service_id: ids.service, idempotency_key: 'service.updated:2' }))
      .resolves.toEqual({ outcome: 'stale' });
  });
});
