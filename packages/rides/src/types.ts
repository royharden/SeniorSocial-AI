export const rideStates = [
  'draft',
  'requested',
  'waiting_for_dispatcher',
  'confirmed_by',
  'completed',
  'cancelled',
  'unable_to_fulfill',
] as const;
export type RideState = (typeof rideStates)[number];

export const rideModes = ['paratransit', 'taxi_voucher', 'rideshare', 'partner_van'] as const;
export type RideMode = (typeof rideModes)[number];

export const accessibilityCodes = [
  'wheelchair',
  'walker',
  'needs_an_arm',
  'service_animal',
  'oxygen',
  'door_to_door',
] as const;
export type AccessibilityCode = (typeof accessibilityCodes)[number];

export interface Actor {
  id: string;
  orgId: string;
  roles: readonly ('senior' | 'caregiver' | 'staff' | 'admin' | 'partner' | 'support')[];
}
export interface AccessibilityCondition { code: AccessibilityCode; label: string }
export interface RideRequestInput {
  residentId: string;
  purpose: string;
  mode: RideMode;
  pickupAt: string;
  pickupTz: string;
  pickupLocation: string;
  destinationLocation: string;
  returnNeeded: boolean;
  accessibilityConditions: readonly AccessibilityCondition[];
}
export type SendState = 'not_sent' | 'sent' | 'send_failed';
export interface RideTransition {
  id: string;
  actorId: string;
  from: RideState;
  to: RideState;
  at: string;
  reason: string | null;
  providerEvidence: string | null;
  idempotencyKey: string;
}
export interface RideRequest extends RideRequestInput {
  id: string;
  orgId: string;
  requestedByActorId: string;
  state: RideState;
  sendState: SendState;
  dispatchReference: string | null;
  createdAt: string;
  transitions: readonly RideTransition[];
  confirmedByActor: string | null;
  confirmedAt: string | null;
}
export interface RidePage { items: RideRequest[]; meta: { next_cursor: null; total_known: true } }

export interface NewRide extends RideRequestInput {
  id: string;
  orgId: string;
  requestedByActorId: string;
  idempotencyKey: string;
  requestHash: string;
  at: string;
}
export interface CreateResult { ride: RideRequest; created: boolean }
export interface RideRepository {
  create(input: NewRide): Promise<CreateResult>;
  find(orgId: string, rideId: string): Promise<RideRequest | null>;
  listForResident(orgId: string, residentId: string): Promise<RideRequest[]>;
  listQueue(orgId: string): Promise<RideRequest[]>;
  recordDispatch(orgId: string, rideId: string, actorId: string, result: DispatchResult, at: string): Promise<RideRequest>;
  transition(orgId: string, rideId: string, actorId: string, to: RideState, reason: string | null, providerEvidence: string | null, at: string, idempotencyKey: string, requestHash: string): Promise<RideRequest | null>;
}
export interface Authorization {
  canRead(actor: Actor, ride: RideRequest): Promise<boolean>;
  canCreate(actor: Actor, residentId: string): Promise<boolean>;
  canListQueue(actor: Actor): Promise<boolean>;
  canTransition(actor: Actor, ride: RideRequest, to: RideState): Promise<boolean>;
}
export interface DispatchPayload {
  rideId: string;
  orgId: string;
  residentId: string;
  idempotencyKey: string;
  purpose: string;
  pickupAt: string;
  pickupTz: string;
  pickupLocation: string;
  destinationLocation: string;
  returnNeeded: boolean;
  accessibilityConditions: readonly AccessibilityCondition[];
}
export type DispatchResult =
  | { outcome: 'accepted_for_review'; evidence: string }
  | { outcome: 'failed'; reason: string };
export interface DispatchPort { submit(payload: DispatchPayload): Promise<DispatchResult> }
/** Trusted provider/dispatcher evidence boundary; request JSON is never evidence. */
export interface ConfirmationPort { evidence(actor: Actor, ride: RideRequest): Promise<string | null> }
export type RideDomainEvent =
  | { name: 'ride.requested'; payload: { ride_id: string; org_id: string; requester_id: string; on_behalf_of: string | null } }
  | { name: 'ride.transitioned'; payload: { ride_id: string; from_state: RideState; to_state: RideState; actor_id: string; at: string } };
export interface RideEventPublisher { publish(event: RideDomainEvent): Promise<void> }
export interface RideJobQueue {
  enqueue(name: 'rides.dispatch.notify', payload: { idempotency_key: string; ride_id: string; to_role: 'staff' }): Promise<void>;
}
