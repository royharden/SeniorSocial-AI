import { randomUUID } from 'node:crypto';
import { assertTransition } from './state-machine.ts';
import type { CreateResult, DispatchResult, NewRide, RideRepository, RideRequest, RideState, RideTransition } from './types.ts';

export class MemoryRideRepository implements RideRepository {
  readonly rides: RideRequest[] = [];
  readonly idempotency = new Map<string, { hash: string; rideId: string }>();
  readonly transitionIdempotency = new Map<string, { hash: string; rideId: string }>();

  async create(input: NewRide): Promise<CreateResult> {
    const key = `${input.orgId}:${input.residentId}:${input.idempotencyKey}`;
    const prior = this.idempotency.get(key);
    if (prior) {
      if (prior.hash !== input.requestHash) throw new Error('Idempotency key reused with different request');
      const ride = await this.find(input.orgId, prior.rideId);
      if (!ride) throw new Error('Idempotency record is corrupt');
      return { ride, created: false };
    }
    const transition: RideTransition = { id: randomUUID(), actorId: input.requestedByActorId,
      from: 'draft', to: 'requested', at: input.at, reason: 'ride_request_submitted', providerEvidence: null,
      idempotencyKey: `create:${input.idempotencyKey}` };
    const ride: RideRequest = { id: input.id, orgId: input.orgId, residentId: input.residentId,
      requestedByActorId: input.requestedByActorId, purpose: input.purpose, mode: input.mode,
      pickupAt: input.pickupAt, pickupTz: input.pickupTz, pickupLocation: input.pickupLocation,
      destinationLocation: input.destinationLocation, returnNeeded: input.returnNeeded,
      accessibilityConditions: input.accessibilityConditions.map(item => ({ ...item })), state: 'requested',
      sendState: 'not_sent', dispatchReference: null, createdAt: input.at, transitions: [transition],
      confirmedByActor: null, confirmedAt: null };
    this.rides.push(ride); this.idempotency.set(key, { hash: input.requestHash, rideId: ride.id });
    return { ride: clone(ride), created: true };
  }

  find(orgId: string, rideId: string): Promise<RideRequest | null> {
    const ride = this.rides.find(item => item.orgId === orgId && item.id === rideId);
    return Promise.resolve(ride ? clone(ride) : null);
  }
  listForResident(orgId: string, residentId: string): Promise<RideRequest[]> {
    return Promise.resolve(this.rides.filter(item => item.orgId === orgId && item.residentId === residentId).map(clone));
  }
  listQueue(orgId: string): Promise<RideRequest[]> {
    return Promise.resolve(this.rides.filter(item => item.orgId === orgId && ['requested', 'waiting_for_dispatcher', 'confirmed_by'].includes(item.state)).map(clone));
  }
  recordDispatch(orgId: string, rideId: string, actorId: string, result: DispatchResult, at: string): Promise<RideRequest> {
    const ride = this.require(orgId, rideId);
    if (ride.sendState === 'sent') return Promise.resolve(clone(ride));
    if (result.outcome === 'failed') { ride.sendState = 'send_failed'; return Promise.resolve(clone(ride)); }
    ride.sendState = 'sent'; ride.dispatchReference = result.evidence;
    if (ride.state === 'requested') this.apply(ride, actorId, 'waiting_for_dispatcher', 'dispatch_received', result.evidence, at, `dispatch:${result.evidence}`);
    return Promise.resolve(clone(ride));
  }
  transition(orgId: string, rideId: string, actorId: string, to: RideState, reason: string | null, evidence: string | null, at: string, idempotencyKey: string, requestHash: string): Promise<RideRequest | null> {
    const ride = this.rides.find(item => item.orgId === orgId && item.id === rideId);
    if (!ride) return Promise.resolve(null);
    const key = `${orgId}:${rideId}:${idempotencyKey}`;
    const prior = this.transitionIdempotency.get(key);
    if (prior) {
      if (prior.hash !== requestHash) throw new Error('Idempotency key reused with different transition');
      return Promise.resolve(clone(ride));
    }
    this.apply(ride, actorId, to, reason, evidence, at, idempotencyKey);
    this.transitionIdempotency.set(key, { hash: requestHash, rideId });
    return Promise.resolve(clone(ride));
  }
  private require(orgId: string, rideId: string) {
    const ride = this.rides.find(item => item.orgId === orgId && item.id === rideId);
    if (!ride) throw new Error('Ride not found'); return ride;
  }
  private apply(ride: RideRequest, actorId: string, to: RideState, reason: string | null, evidence: string | null, at: string, idempotencyKey: string) {
    assertTransition(ride.state, to, evidence);
    const transition = { id: randomUUID(), actorId, from: ride.state, to, at, reason, providerEvidence: evidence, idempotencyKey };
    (ride.transitions as RideTransition[]).push(transition); ride.state = to;
    if (to === 'confirmed_by') { ride.confirmedByActor = actorId; ride.confirmedAt = at; }
  }
}

function clone(ride: RideRequest): RideRequest { return structuredClone(ride); }
