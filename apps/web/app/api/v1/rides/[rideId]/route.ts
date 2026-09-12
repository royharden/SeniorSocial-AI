import { present, problem, status, type RideHttpDependencies } from '../_http';
import { runtimeDependencies } from '../_runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function createGetRideHandler(dependencies: RideHttpDependencies) {
  return async function GET(request: Request, context: { params: Promise<{ rideId: string }> }): Promise<Response> {
    const actor = await dependencies.authorize(request);
    if (!actor) return problem(403, 'Forbidden');
    try { return Response.json(present(await dependencies.rides.get(actor, (await context.params).rideId)), { headers: { 'cache-control': 'no-store' } }); }
    catch (error) { return status(error); }
  };
}

export const GET = createGetRideHandler(runtimeDependencies);
