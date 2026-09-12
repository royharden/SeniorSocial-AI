import type { EventsService } from '../../../../../../../../packages/events/src/index.ts';
import { authenticated, problem, resultResponse, withEventRuntime, type EventRouteContext } from '../../_runtime';

interface Context { params: Promise<{ eventId: string }> }
export interface RsvpDependencies { authorize(request: Request): Promise<EventRouteContext | null>; run<T>(work: (service: EventsService) => Promise<T>): Promise<T> }
export function createRsvpHandlers(dependencies: RsvpDependencies) {
  return {
    POST: async (request: Request, context: Context): Promise<Response> => {
      const identity = await dependencies.authorize(request);
      if (!identity) return problem(401, 'session_required');
      const { eventId } = await context.params;
      return resultResponse(await dependencies.run(service => service.rsvp(identity, eventId)), 201);
    },
    DELETE: async (request: Request, context: Context): Promise<Response> => {
      const identity = await dependencies.authorize(request);
      if (!identity) return problem(401, 'session_required');
      const { eventId } = await context.params;
      const result = await dependencies.run(service => service.cancel(identity, eventId));
      if ('status' in result) return resultResponse(result);
      return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
    },
  };
}
const handlers = createRsvpHandlers({ authorize: authenticated, run: withEventRuntime });
export const POST = handlers.POST;
export const DELETE = handlers.DELETE;
