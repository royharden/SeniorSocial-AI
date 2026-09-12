import { describe, expect, it } from 'vitest';
import { RideNotFound, type Actor } from '../../../packages/rides/src/index';
import { fixture, otherOrg, requestedRide, resident, staff } from '../../unit/WP-013/fixture';

describe('WP-013 tenant and authorization isolation', () => {
  it('cross-org reads and transitions reveal no request existence', async () => {
    const f = fixture(); const ride = await requestedRide(f);
    const outsider: Actor = { ...staff, orgId: otherOrg };
    await expect(f.service.get(outsider, ride.id)).rejects.toBeInstanceOf(RideNotFound);
    await expect(f.service.transition(outsider, ride.id, { to: 'cancelled' }, 'cross-org')).rejects.toBeInstanceOf(RideNotFound);
  });

  it('only operators receive the staff queue and residents only list themselves', async () => {
    const f = fixture(); await requestedRide(f);
    await expect(f.service.listQueue(resident)).rejects.toMatchObject({ status: 403 });
    expect((await f.service.listQueue(staff)).items).toHaveLength(1);
  });
});
