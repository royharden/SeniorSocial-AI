import type { EventsService } from '../../../../../../../../packages/events/src/index.ts';
import { authenticated, problem, resultResponse, withEventRuntime, type EventRouteContext } from '../../_runtime';

interface Context { params: Promise<{ eventId: string }> }
export interface WaitlistDependencies { authorize(request: Request): Promise<EventRouteContext | null>; run<T>(work: (service: EventsService) => Promise<T>): Promise<T> }
export function createWaitlistHandler(dependencies: WaitlistDependencies) {
  return async function post(request: Request, context: Context): Promise<Response> {
    const identity = await dependencies.authorize(request);
    if (!identity) return problem(401, 'session_required');
    const { eventId } = await context.params;
    return resultResponse(await dependencies.run(service => service.waitlist(identity, eventId)), 201);
  };
}
export const POST = createWaitlistHandler({ authorize: authenticated, run: withEventRuntime });
