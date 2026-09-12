import { body, input, present, problem, status, type RideHttpDependencies } from './_http';
import { runtimeDependencies } from './_runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function createRidesHandlers(dependencies: RideHttpDependencies) {
  return {
    GET: async (request: Request): Promise<Response> => {
      const actor = await dependencies.authorize(request);
      if (!actor) return problem(403, 'Forbidden');
      try {
        const page = await dependencies.rides.listMine(actor);
        return Response.json({ items: page.items.map(present), meta: page.meta }, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return status(error); }
    },
    POST: async (request: Request): Promise<Response> => {
      const actor = await dependencies.authorize(request);
      if (!actor) return problem(403, 'Forbidden');
      const value = await body(request);
      const key = request.headers.get('idempotency-key') ?? '';
      if (!value) return problem(422, 'Invalid ride request');
      try {
        const residentId = actor.roles.includes('caregiver') && typeof value.resident_id === 'string' ? value.resident_id : actor.id;
        const ride = await dependencies.rides.create(actor, input(value, residentId), key);
        return Response.json(present(ride), { status: 201, headers: { 'cache-control': 'no-store' } });
      } catch (error) { return status(error); }
    },
  };
}

const handlers = createRidesHandlers(runtimeDependencies);
export const GET = handlers.GET;
export const POST = handlers.POST;
