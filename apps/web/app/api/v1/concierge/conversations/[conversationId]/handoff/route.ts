import type { ConciergeRouteDependencies, RouteContext } from '../../../_shared.ts';
import { hasRequestPayload, noStore, problem, requireSameOrigin, routeError } from '../../../_shared.ts';
import { conciergeRouteDependencies } from '../../../_runtime.ts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function createHandoffHandler(dependencies: ConciergeRouteDependencies) {
  return async function post(request: Request, context: RouteContext): Promise<Response> {
    const session = await dependencies.authorize(request);
    if (!session) return problem(401, 'An authenticated server session is required');
    const originProblem = requireSameOrigin(request);
    if (originProblem) return originProblem;
    if (await hasRequestPayload(request)) return problem(400, 'This locked endpoint does not accept a request body');
    try {
      const { conversationId } = await context.params;
      const result = await dependencies.concierge.handoff(session, conversationId);
      return result ? noStore(result, 201) : problem(404, 'Conversation not found');
    } catch (error) {
      return routeError(error);
    }
  };
}

export const POST = createHandoffHandler(conciergeRouteDependencies);
