import type { EventsService } from '../../../../../../../packages/events/src/index.ts';
import { authenticated, problem, resultResponse, withEventRuntime, type EventRouteContext } from '../../events/_runtime';

export interface RecommendationDependencies { authorize(request: Request): Promise<EventRouteContext | null>; run<T>(work: (service: EventsService) => Promise<T>): Promise<T> }
export function createRecommendationHandler(dependencies: RecommendationDependencies) {
  return async function get(request: Request): Promise<Response> {
    const identity = await dependencies.authorize(request);
    if (!identity) return problem(401, 'session_required');
    return resultResponse(await dependencies.run(service => service.recommend(identity)));
  };
}
export const GET = createRecommendationHandler({ authorize: authenticated, run: withEventRuntime });
