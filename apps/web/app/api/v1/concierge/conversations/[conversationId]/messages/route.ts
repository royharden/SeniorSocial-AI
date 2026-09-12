import type { ConciergeLocale } from '../../../../../../concierge/types.ts';
import type { ConciergeRouteDependencies, RouteContext } from '../../../_shared.ts';
import { noStore, objectBody, problem, routeError } from '../../../_shared.ts';
import { conciergeRouteDependencies } from '../../../_runtime.ts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const allowed = new Set(['text', 'locale']);

export function createSendMessageHandler(dependencies: ConciergeRouteDependencies) {
  return async function post(request: Request, context: RouteContext): Promise<Response> {
    const session = await dependencies.authorize(request);
    if (!session) return problem(401, 'An authenticated server session is required');
    const body = await objectBody(request);
    if (!body || Object.keys(body).some(key => !allowed.has(key)) || typeof body.text !== 'string') {
      return problem(422, 'Only text and an optional locale are accepted');
    }
    if (body.locale !== undefined && body.locale !== 'en' && body.locale !== 'es') return problem(422, 'locale must be en or es');
    const locale: ConciergeLocale = body.locale ?? session.locale;
    try {
      const { conversationId } = await context.params;
      const answer = await dependencies.concierge.answer(session, conversationId, body.text, locale);
      return answer ? noStore(answer) : problem(404, 'Conversation not found');
    } catch (error) {
      return routeError(error);
    }
  };
}

export const POST = createSendMessageHandler(conciergeRouteDependencies);
