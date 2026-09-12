import { describe, expect, it, vi } from 'vitest';
import { aiEnabled, flagKeys, RequestFlagCache } from '../../../packages/flags/src/index.ts';

describe('WP-006 feature flag evaluation', () => {
  // what_bug_this_catches: a feature switch is consulted without the master kill switch.
  it('checks ai.master and the selected feature independently', async () => {
    const effective = vi.fn(async (flag: string) => flag !== 'ai.moderation');
    expect(await aiEnabled({ effective }, 'ai.moderation', '11111111-1111-4111-8111-111111111111')).toBe(false);
    expect(effective.mock.calls.map(call => call[0])).toEqual(['ai.master', 'ai.moderation']);
  });

  // what_bug_this_catches: feature code reaches its feature or provider after the global emergency kill fires.
  it('short-circuits every AI feature when ai.master is off', async () => {
    const effective = vi.fn(async () => false);
    expect(await aiEnabled({ effective }, 'ai.concierge', '11111111-1111-4111-8111-111111111111')).toBe(false);
    expect(effective).toHaveBeenCalledOnce();
    expect(effective).toHaveBeenCalledWith('ai.master', '11111111-1111-4111-8111-111111111111', undefined);
  });

  // what_bug_this_catches: a request cache leaks one organisation's flag value into another organisation.
  it('keys request-scoped cache by both org and flag', async () => {
    const readEffective = vi.fn(async (_flag: string, org: string) => org.startsWith('1'));
    const cache = new RequestFlagCache({ readEffective } as never);
    const first = await cache.effective('ai.master', '11111111-1111-4111-8111-111111111111');
    const again = await cache.effective('ai.master', '11111111-1111-4111-8111-111111111111');
    const other = await cache.effective('ai.master', '22222222-2222-4222-8222-222222222222');
    expect([first, again, other]).toEqual([true, true, false]);
    expect(readEffective).toHaveBeenCalledTimes(2);
  });

  it('keeps the adopted flag vocabulary closed', () => {
    expect(flagKeys).toHaveLength(24);
    expect(new Set(flagKeys).size).toBe(flagKeys.length);
  });
});
