import { describe, expect, it } from 'vitest';
import { contracts } from '../../contract/WP-002/runtime-adapter';
const ride = ['draft', 'requested', 'waiting_for_dispatcher', 'confirmed_by', 'completed', 'cancelled', 'unable_to_fulfill'];
const assistance = ['pending_unowned', 'owned', 'in_progress', 'resolved', 'closed_unable'];
describe('CK-049 primary shared request vocabulary', () => {
  // what_bug_this_catches: UI/SMS consumers receive a vocabulary that differs from the primary API contract.
  it('CK-049 exports the adopted ride and assistance vocabulary without peer substitutions', async () => {
    const runtime = await contracts();
    expect([...runtime.requestStatusVocabulary.ride]).toEqual(ride);
    expect([...runtime.requestStatusVocabulary.assistance]).toEqual(assistance);
  });
  for (const [name, allowed] of [['RideRequest', ride], ['AssistanceRequest', assistance]] as const) {
    // what_bug_this_catches: the exported vocabulary and runtime validator disagree on valid or invented states.
    it(`CK-049 ${name} accepts every adopted state and rejects invented confirmation`, async () => {
      const runtime = await contracts();
      const base = { id: '10000000-0000-4000-8000-000000000001', org_id: '20000000-0000-4000-8000-000000000001' };
      for (const state of allowed) expect(runtime.schemas[name].safeParse({ ...base, state }).success).toBe(true);
      for (const state of ['booked', 'accepted', 'fulfilled', '', null, 1]) expect(runtime.schemas[name].safeParse({ ...base, state }).success).toBe(false);
    });
  }
});
