import type { ConciergeRouteDependencies, RouteContext } from '../../_shared.ts';
import { noStore, problem, routeError } from '../../_shared.ts';
import { conciergeRouteDependencies } from '../../_runtime.ts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function createGetConversationHandler(dependencies: ConciergeRouteDependencies) {
  return async function get(request: Request, context: RouteContext): Promise<Response> {
    const session = await dependencies.authorize(request);
    if (!session) return problem(401, 'An authenticated server session is required');
    try {
      const { conversationId } = await context.params;
      const conversation = await dependencies.concierge.get(session, conversationId);
      return conversation ? noStore(conversation) : problem(404, 'Conversation not found');
    } catch (error) {
      return routeError(error);
    }
  };
}

export const GET = createGetConversationHandler(conciergeRouteDependencies);
