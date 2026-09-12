import type { EventsService } from '../../../../../../../packages/events/src/index.ts';
import { authenticated, problem, resultResponse, withEventRuntime, type EventRouteContext } from '../_runtime';

interface Context { params: Promise<{ eventId: string }> }
export interface GetEventDependencies { authorize(request: Request): Promise<EventRouteContext | null>; run<T>(work: (service: EventsService) => Promise<T>): Promise<T> }
export function createGetEventHandler(dependencies: GetEventDependencies) {
  return async function get(request: Request, context: Context): Promise<Response> {
    const identity = await dependencies.authorize(request);
    if (!identity) return problem(401, 'session_required');
    const { eventId } = await context.params;
    return resultResponse(await dependencies.run(service => service.get(identity, eventId)));
  };
}
export const GET = createGetEventHandler({ authorize: authenticated, run: withEventRuntime });
