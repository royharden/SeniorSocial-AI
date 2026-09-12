import type { ConciergeRouteDependencies } from '../_shared.ts';
import { hasRequestPayload, noStore, problem, routeError } from '../_shared.ts';
import { conciergeRouteDependencies } from '../_runtime.ts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function createStartConversationHandler(dependencies: ConciergeRouteDependencies) {
  return async function post(request: Request): Promise<Response> {
    const session = await dependencies.authorize(request);
    if (!session) return problem(401, 'An authenticated server session is required');
    if (await hasRequestPayload(request)) {
      return problem(400, 'This endpoint does not accept client identity or request fields');
    }
    try {
      return noStore(await dependencies.concierge.start(session), 201);
    } catch (error) {
      return routeError(error);
    }
  };
}

export const POST = createStartConversationHandler(conciergeRouteDependencies);
