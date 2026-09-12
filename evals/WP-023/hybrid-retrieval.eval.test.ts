import { describe, expect, it, vi } from 'vitest';
import { createRagService, type RagRepository } from '../../packages/rag/src/index.ts';

describe('WP-023 deterministic retrieval eval', () => {
  // what_bug_this_catches: semantic enablement drops the exact-match directory citation or returns prose instead of evidence ids.
  it('keeps the exact meal listing first in the hybrid citation set', async () => {
    const exact = '11111111-1111-4111-8111-111111111151';
    const semantic = '11111111-1111-4111-8111-111111111152';
    const repository = { prepare: vi.fn(), replace: vi.fn(), hybrid: vi.fn().mockResolvedValue([
      { service_id: exact, score: 1 }, { service_id: semantic, score: 0.49 },
    ]) } as unknown as RagRepository;
    const service = createRagService({ flags: { effective: vi.fn().mockResolvedValue(true) }, repository,
      gateway: { embed: vi.fn().mockResolvedValue({ outcome: 'ok', vectors: [[0.2, 0.8]], dimensions: 2, model: 'stub' }) },
      fts: { search: vi.fn().mockResolvedValue({ items: [{ id: exact }] }) },
      jobs: { resolveService: vi.fn().mockResolvedValue(null) } });
    const response = await service.search({ orgId: '11111111-1111-4111-8111-111111111111',
      userId: '11111111-1111-4111-8111-111111111101', requestId: '11111111-1111-4111-8111-111111111191',
      userRole: 'senior', locale: 'en', query: 'meal delivery', limit: 2 });
    expect(response.items.map(item => item.service_id)).toEqual([exact, semantic]);
    expect(JSON.stringify(response)).not.toMatch(/meal|delivery|answer|text/iu);
  });
});
