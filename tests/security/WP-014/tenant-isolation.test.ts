import { describe, expect, it } from 'vitest';
import { AssistanceService, FixedUtcBusinessHours, MemoryAssistanceRepository, type Identity } from '../../../packages/assistance/src/index.ts';

const orgA = '11111111-1111-4111-8111-111111111111';
const orgB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const userA = '22222222-2222-4222-8222-222222222222';
const userB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const requestId = '44444444-4444-4444-8444-444444444444';
const identity = (orgId: string, userId: string): Identity => ({ orgId, userId, roles: ['senior'] });

describe('assistance tenant isolation', () => {
  it('hides cross-organisation reads and returns no queue entries', async () => {
    const repository = new MemoryAssistanceRepository();
    const service = new AssistanceService({ repository, ids: { next: () => requestId }, hours: new FixedUtcBusinessHours(),
      codec: { seal: value => Promise.resolve(value), open: value => Promise.resolve(value) },
      authorization: { authorize: (actor, resource) => Promise.resolve(actor.userId === resource.residentId) } });
    await service.create(identity(orgA, userA), { summary: 'housing help', idempotencyKey: 'security-key' });
    await expect(service.get(identity(orgB, userB), requestId)).rejects.toThrow('not_found');
    expect(await service.listMine(identity(orgB, userB))).toEqual([]);
  });
});
