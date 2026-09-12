import { createRideService, MemoryRideRepository, type Actor, type Authorization, type DispatchPayload, type DispatchResult, type RideRequest } from '../../../packages/rides/src/index';

export const org = '11111111-1111-4111-8111-111111111111';
export const residentId = '22222222-2222-4222-8222-222222222222';
export const staffId = '33333333-3333-4333-8333-333333333333';
export const otherOrg = '44444444-4444-4444-8444-444444444444';
export const resident: Actor = { id: residentId, orgId: org, roles: ['senior'] };
export const staff: Actor = { id: staffId, orgId: org, roles: ['staff'] };

export const input = {
  residentId,
  purpose: 'Clinic appointment',
  mode: 'partner_van' as const,
  pickupAt: '2026-11-01T12:30:00.000Z',
  pickupTz: 'America/New_York',
  pickupLocation: 'Home',
  destinationLocation: 'Community clinic',
  returnNeeded: true,
  accessibilityConditions: [{ code: 'wheelchair' as const, label: 'I use my wide power wheelchair' }],
};

export function fixture(options: { fail?: boolean; failAttempts?: number; throwDispatch?: boolean; confirmationEvidence?: string | null } = {}) {
  const repository = new MemoryRideRepository();
  const bookings = new Map<string, DispatchPayload>();
  let attempts = 0;
  const dispatch = {
    calls: [] as DispatchPayload[],
    submit(payload: DispatchPayload): Promise<DispatchResult> {
      this.calls.push(structuredClone(payload));
      attempts += 1;
      if (options.throwDispatch) return Promise.reject(new Error('synthetic_dispatch_unavailable'));
      if (options.fail || attempts <= (options.failAttempts ?? 0)) return Promise.resolve({ outcome: 'failed', reason: 'synthetic_dispatch_unavailable' });
      bookings.set(payload.idempotencyKey, structuredClone(payload));
      return Promise.resolve({ outcome: 'accepted_for_review', evidence: `synthetic:${payload.idempotencyKey}` });
    },
  };
  const authorization: Authorization = {
    canRead: (actor, ride) => Promise.resolve(actor.orgId === ride.orgId && (actor.id === ride.residentId || actor.roles.some(role => role === 'staff' || role === 'admin'))),
    canCreate: (actor, target) => Promise.resolve(actor.orgId === org && actor.id === target && actor.roles.includes('senior')),
    canListQueue: actor => Promise.resolve(actor.orgId === org && actor.roles.some(role => role === 'staff' || role === 'admin')),
    canTransition: (actor, ride, to) => Promise.resolve(actor.orgId === ride.orgId && (actor.roles.some(role => role === 'staff' || role === 'admin') || (actor.id === ride.residentId && to === 'cancelled'))),
  };
  let tick = 0;
  const events: unknown[] = [];
  const jobs: unknown[] = [];
  const service = createRideService({ repository, authorization, dispatch,
    confirmation: { evidence: () => Promise.resolve(options.confirmationEvidence ?? null) },
    events: { publish: event => { events.push(structuredClone(event)); return Promise.resolve(); } },
    jobs: { enqueue: (name, payload) => { jobs.push({ name, payload: structuredClone(payload) }); return Promise.resolve(); } },
    clock: () => new Date(Date.UTC(2026, 8, 10, 12, 0, tick++)),
    uuid: () => '55555555-5555-4555-8555-555555555555' });
  return { repository, dispatch, bookings, events, jobs, service };
}

export async function requestedRide(f = fixture()): Promise<RideRequest> {
  return f.service.create(resident, input, 'ride-key-1');
}
