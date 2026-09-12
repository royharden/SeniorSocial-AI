import { createHash, randomUUID } from 'node:crypto';
import { RideConflict } from './state-machine.ts';
import { isIdempotencyKey, isRideState, isUuid, parseRideInput } from './validation.ts';
import type { Actor, Authorization, ConfirmationPort, DispatchPort, RideEventPublisher, RideJobQueue, RideRepository } from './types.ts';

export interface RideDependencies {
  repository: RideRepository;
  authorization: Authorization;
  dispatch: DispatchPort;
  confirmation: ConfirmationPort;
  events: RideEventPublisher;
  jobs: RideJobQueue;
  clock?: () => Date;
  uuid?: () => string;
}

export class RideNotFound extends Error { readonly status = 404; }
export class RideForbidden extends Error { readonly status = 403; }

export function createRideService(dependencies: RideDependencies) {
  const now = dependencies.clock ?? (() => new Date());
  const newId = dependencies.uuid ?? randomUUID;

  async function findAuthorized(actor: Actor, rideId: string) {
    if (!validActor(actor) || !isUuid(rideId)) throw new RideNotFound();
    const ride = await dependencies.repository.find(actor.orgId, rideId);
    if (!ride || !await dependencies.authorization.canRead(actor, ride)) throw new RideNotFound();
    return ride;
  }

  async function create(actor: Actor, raw: unknown, idempotencyKey: string) {
    if (!validActor(actor) || !isIdempotencyKey(idempotencyKey)) throw new RideForbidden();
    const input = parseRideInput(raw);
    if (!await dependencies.authorization.canCreate(actor, input.residentId)) throw new RideForbidden();
    const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const at = now().toISOString();
    const result = await dependencies.repository.create({ ...input, id: newId(), orgId: actor.orgId,
      requestedByActorId: actor.id, idempotencyKey, requestHash: hash, at });
    let updated = result.ride;
    let dispatchAccepted = false;
    if (updated.sendState !== 'sent') {
      let dispatch;
      try {
        dispatch = await dependencies.dispatch.submit({ rideId: result.ride.id, orgId: result.ride.orgId,
          residentId: result.ride.residentId, idempotencyKey: `${actor.orgId}:${input.residentId}:ride:${idempotencyKey}`,
          purpose: result.ride.purpose, pickupAt: result.ride.pickupAt, pickupTz: result.ride.pickupTz,
          pickupLocation: result.ride.pickupLocation, destinationLocation: result.ride.destinationLocation,
          returnNeeded: result.ride.returnNeeded,
          accessibilityConditions: result.ride.accessibilityConditions.map(item => ({ ...item })) });
        if (dispatch.outcome === 'accepted_for_review' && (!dispatch.evidence.trim() || dispatch.evidence.length > 200)) {
          dispatch = { outcome: 'failed' as const, reason: 'dispatch_evidence_missing' };
        }
      } catch {
        dispatch = { outcome: 'failed' as const, reason: 'dispatch_unavailable' };
      }
      updated = await dependencies.repository.recordDispatch(actor.orgId, result.ride.id, actor.id, dispatch, now().toISOString());
      dispatchAccepted = updated.sendState === 'sent';
    }
    if (result.created) await dependencies.events.publish({ name: 'ride.requested', payload: { ride_id: updated.id, org_id: updated.orgId,
      requester_id: actor.id, on_behalf_of: actor.id === updated.residentId ? null : updated.residentId } });
    if (dispatchAccepted) {
      const transition = updated.transitions.at(-1);
      if (transition?.to === 'waiting_for_dispatcher') await dependencies.events.publish({ name: 'ride.transitioned', payload: {
        ride_id: updated.id, from_state: transition.from, to_state: transition.to, actor_id: transition.actorId, at: transition.at,
      } });
      await dependencies.jobs.enqueue('rides.dispatch.notify', {
        idempotency_key: `${updated.orgId}:${updated.id}:dispatch`, ride_id: updated.id, to_role: 'staff',
      });
    }
    return updated;
  }

  async function transition(actor: Actor, rideId: string, raw: unknown, idempotencyKey: string) {
    const ride = await findAuthorized(actor, rideId);
    if (!isIdempotencyKey(idempotencyKey)) throw new RideConflict('Idempotency-Key is required');
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new RideConflict('Invalid transition');
    const value = raw as Record<string, unknown>;
    if (!isRideState(value.to)) throw new RideConflict('Invalid transition state');
    const reason = value.reason === undefined ? null : typeof value.reason === 'string' && value.reason.trim().length > 0 && value.reason.length <= 500 ? value.reason.trim() : null;
    const replay = ride.transitions.some(item => item.idempotencyKey === idempotencyKey);
    let evidence: string | null = null;
    if (value.to === 'confirmed_by' && !replay) {
      try { evidence = await dependencies.confirmation.evidence(actor, ride); } catch { evidence = null; }
    }
    if (!await dependencies.authorization.canTransition(actor, ride, value.to)) throw new RideNotFound();
    const at = now().toISOString();
    const requestHash = createHash('sha256').update(JSON.stringify([value.to, reason])).digest('hex');
    const updated = await dependencies.repository.transition(actor.orgId, rideId, actor.id, value.to, reason, evidence, at, idempotencyKey, requestHash);
    if (!updated) throw new RideConflict('Ride changed; reload and try again');
    const latest = updated.transitions.find(item => item.idempotencyKey === idempotencyKey);
    if (latest && !replay) await dependencies.events.publish({ name: 'ride.transitioned', payload: { ride_id: updated.id,
      from_state: latest.from, to_state: latest.to, actor_id: latest.actorId, at: latest.at } });
    return updated;
  }

  async function listMine(actor: Actor) {
    if (!validActor(actor)) throw new RideForbidden();
    return { items: await dependencies.repository.listForResident(actor.orgId, actor.id), meta: { next_cursor: null, total_known: true } } as const;
  }

  async function listQueue(actor: Actor) {
    if (!validActor(actor) || !await dependencies.authorization.canListQueue(actor)) throw new RideForbidden();
    return { items: await dependencies.repository.listQueue(actor.orgId), meta: { next_cursor: null, total_known: true } } as const;
  }

  return { create, get: findAuthorized, transition, listMine, listQueue };
}

function validActor(actor: Actor): boolean {
  return isUuid(actor.id) && isUuid(actor.orgId) && actor.roles.length > 0;
}

export type RideService = ReturnType<typeof createRideService>;
