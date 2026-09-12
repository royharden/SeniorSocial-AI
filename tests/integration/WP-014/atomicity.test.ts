import { describe, expect, it } from 'vitest';
import { AssistanceService, FixedUtcBusinessHours, MemoryAssistanceRepository, type AssistanceRepository } from '../../../packages/assistance/src/index.ts';

describe('atomic assistance writes', () => {
  it('rolls back a domain mutation when the audit append fails', async () => {
    const memory = new MemoryAssistanceRepository();
    const repository: AssistanceRepository = { transaction: (orgId, work) => memory.transaction(orgId, transaction => work({ ...transaction, audit: () => Promise.reject(new Error('audit unavailable')) })) };
    const service = new AssistanceService({ repository, ids: { next: () => '44444444-4444-4444-8444-444444444444' }, hours: new FixedUtcBusinessHours(),
      codec: { seal: value => Promise.resolve(value), open: value => Promise.resolve(value) }, authorization: { authorize: () => Promise.resolve(true) } });
    await expect(service.create({ orgId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222', roles: ['senior'] }, { summary: 'help', idempotencyKey: 'atomic-key' })).rejects.toThrow('audit unavailable');
    expect(memory.requests.size).toBe(0);
  });
});
