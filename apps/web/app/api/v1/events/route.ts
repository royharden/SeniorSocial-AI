import type { EventsService } from '../../../../../../packages/events/src/index.ts';
import { authenticated, problem, resultResponse, withEventRuntime, type EventRouteContext } from './_runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export interface ListEventsDependencies {
  authorize(request: Request): Promise<EventRouteContext | null>;
  run<T>(work: (service: EventsService) => Promise<T>): Promise<T>;
}
export function createListEventsHandler(dependencies: ListEventsDependencies) {
  return async function get(request: Request): Promise<Response> {
    const identity = await dependencies.authorize(request);
    if (!identity) return problem(401, 'session_required');
    const url = new URL(request.url);
    const rawLimit = url.searchParams.get('limit');
    const input = { ...(url.searchParams.has('from') ? { from: url.searchParams.get('from')! } : {}),
      ...(url.searchParams.has('to') ? { to: url.searchParams.get('to')! } : {}),
      ...(url.searchParams.has('cursor') ? { cursor: url.searchParams.get('cursor')! } : {}),
      ...(rawLimit ? { limit: Number(rawLimit) } : {}) };
    return resultResponse(await dependencies.run(service => service.list(identity, input)));
  };
}
export const GET = createListEventsHandler({ authorize: authenticated, run: withEventRuntime });
