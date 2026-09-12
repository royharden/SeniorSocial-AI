import { describe, expect, it } from 'vitest';
import { createRidesHandlers } from '../../../apps/web/app/api/v1/rides/route';
import { createTransitionRideHandler } from '../../../apps/web/app/api/v1/rides/[rideId]/transitions/route';
import { createListRideQueueHandler } from '../../../apps/web/app/api/v1/staff/rides/route';
import { requestStatusVocabulary } from '../../../packages/contracts/src/index';
import { rideStates } from '../../../packages/rides/src/index';
import { fixture, input, resident, staff } from '../../unit/WP-013/fixture';

describe('WP-013 immutable API contract', () => {
  it('keeps runtime state vocabulary aligned with the locked OpenAPI contract', () => {
    expect(requestStatusVocabulary.ride).toEqual(rideStates);
  });

  it('POST ignores client identity, requires an idempotency key, and presents snake_case truth', async () => {
    const f = fixture(); const handlers = createRidesHandlers({ authorize: () => Promise.resolve(resident), rides: f.service });
    const response = await handlers.POST(new Request('http://local/api/v1/rides', { method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'contract-key' },
      body: JSON.stringify({ purpose: input.purpose, mode: input.mode, pickup_at: input.pickupAt, pickup_tz: input.pickupTz,
        pickup_location: input.pickupLocation, destination_location: input.destinationLocation,
        return_needed: input.returnNeeded, accessibility_details: input.accessibilityConditions,
        resident_id: '99999999-9999-4999-8999-999999999999' }) }));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ state: 'waiting_for_dispatcher', send_state: 'sent',
      accessibility_conditions: input.accessibilityConditions.map(item => item.label), accessibility_details: input.accessibilityConditions });
  });

  it('illegal route transitions return RFC 9457-style 409 and no state change', async () => {
    const f = fixture(); const ride = await f.service.create(resident, input, 'transition-key');
    const handler = createTransitionRideHandler({ authorize: () => Promise.resolve(staff), rides: f.service });
    const response = await handler(new Request(`http://local/api/v1/rides/${ride.id}/transitions`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'transition-key' }, body: JSON.stringify({ to: 'completed' }) }), { params: Promise.resolve({ rideId: ride.id }) });
    expect(response.status).toBe(409); expect((await response.json() as { title: string }).title).toBe('Conflict');
    expect((await f.service.get(resident, ride.id)).state).toBe('waiting_for_dispatcher');
  });

  it('requires Idempotency-Key on transition mutations', async () => {
    const f = fixture(); const ride = await f.service.create(resident, input, 'create-key');
    const handler = createTransitionRideHandler({ authorize: () => Promise.resolve(resident), rides: f.service });
    const response = await handler(new Request(`http://local/api/v1/rides/${ride.id}/transitions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: 'cancelled' }),
    }), { params: Promise.resolve({ rideId: ride.id }) });
    expect(response.status).toBe(409);
    expect((await f.service.get(resident, ride.id)).state).toBe('waiting_for_dispatcher');
  });

  it('the locked staff queue is server-authorized and returns only the tenant queue', async () => {
    const f = fixture(); await f.service.create(resident, input, 'queue-key');
    const denied = createListRideQueueHandler({ authorize: () => Promise.resolve(resident), rides: f.service });
    expect((await denied(new Request('http://local/api/v1/staff/rides'))).status).toBe(403);
    const allowed = createListRideQueueHandler({ authorize: () => Promise.resolve(staff), rides: f.service });
    const response = await allowed(new Request('http://local/api/v1/staff/rides'));
    expect(response.status).toBe(200); expect((await response.json() as { items: unknown[] }).items).toHaveLength(1);
  });
});
