import { body, present, problem, status, type RideHttpDependencies } from '../../_http';
import { runtimeDependencies } from '../../_runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function createTransitionRideHandler(dependencies: RideHttpDependencies) {
  return async function POST(request: Request, context: { params: Promise<{ rideId: string }> }): Promise<Response> {
    const actor = await dependencies.authorize(request);
    if (!actor) return problem(403, 'Forbidden');
    const value = await body(request);
    if (!value) return problem(422, 'Invalid ride transition');
    const key = request.headers.get('idempotency-key') ?? '';
    try { return Response.json(present(await dependencies.rides.transition(actor, (await context.params).rideId, value, key)), { headers: { 'cache-control': 'no-store' } }); }
    catch (error) { return status(error); }
  };
}

export const POST = createTransitionRideHandler(runtimeDependencies);
