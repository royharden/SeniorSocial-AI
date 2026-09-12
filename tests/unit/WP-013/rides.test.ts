import { describe, expect, it } from 'vitest';
import { canTransition, rideStates } from '../../../packages/rides/src/index';
import { fixture, input, org, requestedRide, resident, staff } from './fixture';

describe('WP-013 ride request truth and state machine', () => {
  it('CK-010 exports exactly the seven adopted states and keeps unmet distinct from cancellation', () => {
    expect([...rideStates]).toEqual(['draft','requested','waiting_for_dispatcher','confirmed_by','completed','cancelled','unable_to_fulfill']);
    expect(canTransition('waiting_for_dispatcher', 'cancelled')).toBe(true);
    expect(canTransition('waiting_for_dispatcher', 'unable_to_fulfill')).toBe(true);
    expect(canTransition('unable_to_fulfill', 'cancelled')).toBe(false);
  });

  it('CK-006/007 records actor and time and refuses confirmation without adapter evidence', async () => {
    const f = fixture(); const ride = await requestedRide(f);
    expect(ride.state).toBe('waiting_for_dispatcher');
    await expect(f.service.transition(staff, ride.id, { to: 'confirmed_by', providerEvidence: 'client-forged' }, 'confirm-1')).rejects.toThrow('evidence');
    const trusted = fixture({ confirmationEvidence: 'provider:ABC-42' });
    const trustedRide = await requestedRide(trusted);
    const confirmed = await trusted.service.transition(staff, trustedRide.id, { to: 'confirmed_by' }, 'confirm-1');
    expect(confirmed).toMatchObject({ state: 'confirmed_by', confirmedByActor: staff.id });
    expect(typeof confirmed.confirmedAt).toBe('string');
    expect(confirmed.transitions.at(-1)).toMatchObject({ actorId: staff.id, from: 'waiting_for_dispatcher', to: 'confirmed_by', providerEvidence: 'provider:ABC-42' });
    await expect(f.service.transition(staff, ride.id, { to: 'requested' }, 'illegal-1')).rejects.toThrow('Illegal');
  });

  it('CK-026 preserves structured code and resident wording through dispatch', async () => {
    const f = fixture(); await requestedRide(f);
    expect(f.dispatch.calls[0]?.accessibilityConditions).toEqual(input.accessibilityConditions);
    expect(f.bookings.values().next().value?.accessibilityConditions).toEqual(input.accessibilityConditions);
  });

  it('publishes the automatic dispatcher state transition after acceptance', async () => {
    const f = fixture(); const ride = await requestedRide(f);
    expect(ride.state).toBe('waiting_for_dispatcher');
    const automatic = (f.events as Array<{ name: string; payload: Record<string, unknown> }>).find(event =>
      event.name === 'ride.transitioned' && event.payload.to_state === 'waiting_for_dispatcher');
    expect(automatic?.payload).toMatchObject({ ride_id: ride.id, from_state: 'requested', to_state: 'waiting_for_dispatcher' });
  });

  it('keeps a failed send saved, requested and explicitly unconfirmed', async () => {
    const f = fixture({ fail: true }); const ride = await requestedRide(f);
    expect(ride).toMatchObject({ state: 'requested', sendState: 'send_failed', dispatchReference: null, confirmedByActor: null, confirmedAt: null });
    expect((await f.service.listMine(resident)).items).toHaveLength(1);
  });

  it('keeps a rejected dispatch call saved and truthfully marked as failed', async () => {
    const f = fixture({ throwDispatch: true });
    const ride = await requestedRide(f);
    expect(ride).toMatchObject({ state: 'requested', sendState: 'send_failed', dispatchReference: null });
    expect((await f.service.listMine(resident)).items).toEqual([expect.objectContaining({ id: ride.id, sendState: 'send_failed' })]);
  });

  it('retries a saved send failure with the same dispatch identity and one booking', async () => {
    const f = fixture({ failAttempts: 1 });
    const failed = await requestedRide(f);
    const retried = await f.service.create(resident, input, 'ride-key-1');
    expect(failed).toMatchObject({ state: 'requested', sendState: 'send_failed' });
    expect(retried).toMatchObject({ id: failed.id, state: 'waiting_for_dispatcher', sendState: 'sent' });
    expect(f.dispatch.calls).toHaveLength(2);
    expect(f.dispatch.calls[1]?.idempotencyKey).toBe(f.dispatch.calls[0]?.idempotencyKey);
    expect(f.bookings).toHaveLength(1);
    expect(f.jobs).toEqual([{ name: 'rides.dispatch.notify', payload: {
      idempotency_key: `${org}:${failed.id}:dispatch`, ride_id: failed.id, to_role: 'staff',
    } }]);
  });

  it('preserves resident accessibility wording byte-for-byte', async () => {
    const f = fixture();
    const verbatim = '  I use my wide power wheelchair  ';
    const ride = await f.service.create(resident, {
      ...input,
      accessibilityConditions: [{ code: 'wheelchair', label: verbatim }],
    }, 'verbatim-key');
    expect(ride.accessibilityConditions).toEqual([{ code: 'wheelchair', label: verbatim }]);
    expect(f.dispatch.calls[0]?.accessibilityConditions).toEqual([{ code: 'wheelchair', label: verbatim }]);
  });

  it('replays one idempotent record and cannot create a second booking', async () => {
    const f = fixture(); const first = await requestedRide(f); const replay = await f.service.create(resident, input, 'ride-key-1');
    expect(replay.id).toBe(first.id); expect(f.repository.rides).toHaveLength(1); expect(f.bookings).toHaveLength(1);
    expect((f.events as Array<{ name: string }>).filter(event => event.name === 'ride.requested')).toHaveLength(1);
    expect(f.jobs).toHaveLength(1);
    await expect(f.service.create(resident, { ...input, purpose: 'Different trip' }, 'ride-key-1')).rejects.toThrow('different request');
  });

  it('replays a transition without duplicating its mutation or domain event', async () => {
    const f = fixture(); const ride = await requestedRide(f);
    const first = await f.service.transition(resident, ride.id, { to: 'cancelled', reason: 'Changed plans' }, 'cancel-key');
    const replay = await f.service.transition(resident, ride.id, { to: 'cancelled', reason: 'Changed plans' }, 'cancel-key');
    expect(replay.transitions).toHaveLength(first.transitions.length);
    expect((f.events as Array<{ name: string; payload: { to_state?: string } }>).filter(event =>
      event.name === 'ride.transitioned' && event.payload.to_state === 'cancelled')).toHaveLength(1);
  });
});
