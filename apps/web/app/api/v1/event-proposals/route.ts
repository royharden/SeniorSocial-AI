import type { EventProposalInput, EventsService } from '../../../../../../packages/events/src/index.ts';
import { authenticated, parseObject, problem, resultResponse, withEventRuntime, type EventRouteContext } from '../events/_runtime';

export interface ProposalDependencies { authorize(request: Request): Promise<EventRouteContext | null>; run<T>(work: (service: EventsService) => Promise<T>): Promise<T> }
export function createProposalHandler(dependencies: ProposalDependencies) {
  return async function post(request: Request): Promise<Response> {
    const identity = await dependencies.authorize(request);
    if (!identity) return problem(401, 'session_required');
    const input = await parseObject(request);
    if (!input) return problem(422, 'invalid_event_proposal');
    return resultResponse(await dependencies.run(service => service.propose(identity, input as unknown as EventProposalInput)), 201);
  };
}
export const POST = createProposalHandler({ authorize: authenticated, run: withEventRuntime });
