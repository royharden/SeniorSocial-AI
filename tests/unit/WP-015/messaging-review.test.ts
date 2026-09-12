import { describe, expect, it, vi } from 'vitest';
import type { TenantTransaction } from '../../../packages/db/src/index.ts';
import { MessagingHumanReviewAdapter } from '../../../packages/forums/src/index.ts';

describe('WP-015 messaging human-review adapter', () => {
  it('fails the transaction when the native report transition updates no row', async () => {
    const updateResult = Object.assign([], { count: 0 });
    const sql = vi.fn()
      .mockResolvedValueOnce([{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', conversation_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(updateResult) as unknown as TenantTransaction;
    const adapter = new MessagingHumanReviewAdapter();

    await expect(adapter.decide(sql, {
      orgId: '11111111-1111-4111-8111-111111111111',
      userId: '22222222-2222-4222-8222-222222222222',
      roles: ['staff'],
    }, '33333333-3333-4333-8333-333333333333', 'keep', 'Policy M-1 reviewed')).rejects
      .toThrow('messaging moderation state transition did not commit');
    expect(sql).toHaveBeenCalledTimes(3);
  });
});
