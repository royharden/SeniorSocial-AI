import type { Actor, RideRequest, RideService } from '../../../../../../packages/rides/src/index';
import type { RideRequest as RideRequestDto } from '../../../../../../packages/contracts/src/index';

export interface RideHttpDependencies {
  authorize(request: Request): Promise<Actor | null>;
  rides: RideService;
}

export function problem(status: number, title: string): Response {
  return Response.json({ type: 'about:blank', title, status }, {
    status,
    headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store' },
  });
}

export async function body(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await request.json();
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

export function present(ride: RideRequest): RideRequestDto {
  return {
    id: ride.id,
    org_id: ride.orgId,
    purpose: ride.purpose,
    mode: ride.mode,
    pickup_at: ride.pickupAt,
    pickup_tz: ride.pickupTz,
    pickup_location: ride.pickupLocation,
    destination_location: ride.destinationLocation,
    return_needed: ride.returnNeeded,
    accessibility_conditions: ride.accessibilityConditions.map(item => item.label),
    accessibility_details: ride.accessibilityConditions.map(item => ({ code: item.code, label: item.label })),
    state: ride.state,
    confirmed_by_actor: ride.confirmedByActor,
    confirmed_at: ride.confirmedAt,
    send_state: ride.sendState,
    dispatch_reference: ride.dispatchReference,
    transitions: ride.transitions.map(item => ({ id: item.id, actor_id: item.actorId, from: item.from,
      to: item.to, at: item.at, reason: item.reason, provider_evidence: item.providerEvidence })),
  };
}

export function input(value: Record<string, unknown>, residentId: string): Record<string, unknown> {
  return {
    residentId,
    purpose: value.purpose,
    mode: value.mode,
    pickupAt: value.pickup_at,
    pickupTz: value.pickup_tz,
    pickupLocation: value.pickup_location,
    destinationLocation: value.destination_location,
    returnNeeded: value.return_needed,
    accessibilityConditions: value.accessibility_details,
  };
}

export function status(error: unknown): Response {
  const candidate = error as { status?: unknown; message?: unknown };
  const code = typeof candidate.status === 'number' ? candidate.status : candidate.message === 'Invalid ride request' ? 422 : 500;
  const title = code === 404 ? 'Not found' : code === 409 ? 'Conflict' : code === 422 ? 'Invalid ride request' : 'Ride service unavailable';
  return problem(code, title);
}
