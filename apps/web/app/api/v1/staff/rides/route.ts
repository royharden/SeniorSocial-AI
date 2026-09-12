import { present, problem, status, type RideHttpDependencies } from '../../rides/_http';
import { runtimeDependencies } from '../../rides/_runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function createListRideQueueHandler(dependencies: RideHttpDependencies) {
  return async function GET(request: Request): Promise<Response> {
    const actor = await dependencies.authorize(request);
    if (!actor) return problem(403, 'Forbidden');
    try {
      const page = await dependencies.rides.listQueue(actor);
      return Response.json({ items: page.items.map(present), meta: page.meta }, { headers: { 'cache-control': 'no-store' } });
    } catch (error) { return status(error); }
  };
}

export const GET = createListRideQueueHandler(runtimeDependencies);
