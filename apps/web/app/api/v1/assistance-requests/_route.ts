import type { AssistanceRequest, AssistanceService, AssistanceState, Identity } from '../../../../../../packages/assistance/src/index.ts';

export interface AssistanceRouteDependencies {
  authenticate(request: Request): Promise<Identity | null>;
  service: Pick<AssistanceService, 'create' | 'listMine' | 'get' | 'queue' | 'transition'>;
}

function problem(status: number, title: string): Response {
  return Response.json({ type: 'about:blank', title, status }, { status, headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store' } });
}
function present(item: AssistanceRequest) {
  return {
    id: item.id, org_id: item.orgId, summary: item.summary, triage_category: item.triageCategory,
    triage_source: item.triageSource, state: item.state, owner_id: item.ownerId,
    sla_due_at: item.slaDueAt.toISOString(), sla_breached_at: item.slaBreachedAt?.toISOString() ?? null,
    after_hours: item.afterHours,
  };
}
async function body(request: Request): Promise<Record<string, unknown> | null> {
  try { const parsed: unknown = await request.json(); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null; }
  catch { return null; }
}
async function identity(dependencies: AssistanceRouteDependencies, request: Request): Promise<Identity | Response> {
  const authenticated = await dependencies.authenticate(request);
  return authenticated ?? problem(401, 'Authentication required');
}
export function createAssistanceHandlers(dependencies: AssistanceRouteDependencies) {
  return {
    GET: async (request: Request): Promise<Response> => {
      const actor = await identity(dependencies, request); if (actor instanceof Response) return actor;
      try {
        const items = await dependencies.service.listMine(actor);
        return Response.json({ items: items.map(present), meta: { next_cursor: null, total_known: true } }, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return problem(error instanceof Error && error.message === 'forbidden' ? 403 : 500, 'Unable to list assistance requests'); }
    },
    STAFF_QUEUE: async (request: Request): Promise<Response> => {
      const actor = await identity(dependencies, request); if (actor instanceof Response) return actor;
      try {
        const items = await dependencies.service.queue(actor);
        return Response.json({ items: items.map(present), meta: { next_cursor: null, total_known: true } }, { headers: { 'cache-control': 'no-store' } });
      } catch (error) {
        return problem(error instanceof Error && error.message === 'forbidden' ? 403 : 500, 'Unable to list assistance requests');
      }
    },
    POST: async (request: Request): Promise<Response> => {
      const actor = await identity(dependencies, request); if (actor instanceof Response) return actor;
      const input = await body(request);
      if (typeof input?.summary !== 'string') return problem(400, 'Summary is required');
      // The frozen WP-002 contract requires only the request body. Clients may
      // opt into replay protection with this header, but conforming clients
      // that omit it must still be able to create a request.
      const key = request.headers.get('idempotency-key') ?? crypto.randomUUID();
      try {
        const created = await dependencies.service.create(actor, { summary: input.summary, idempotencyKey: key,
          ...(input.locale === 'es' ? { locale: 'es' as const } : {}) });
        return Response.json(present(created), { status: 201, headers: { 'cache-control': 'no-store' } });
      } catch (error) {
        if (error instanceof TypeError) return problem(400, error.message);
        if (error instanceof Error && error.message === 'forbidden') return problem(403, 'Request not authorized');
        return problem(500, 'Unable to save assistance request');
      }
    },
    GET_ONE: async (request: Request, requestId: string): Promise<Response> => {
      const actor = await identity(dependencies, request); if (actor instanceof Response) return actor;
      try { return Response.json(present(await dependencies.service.get(actor, requestId)), { headers: { 'cache-control': 'no-store' } }); }
      catch { return problem(404, 'Not found'); }
    },
    TRANSITION: async (request: Request, requestId: string): Promise<Response> => {
      const actor = await identity(dependencies, request); if (actor instanceof Response) return actor;
      const input = await body(request);
      if (typeof input?.to !== 'string') return problem(400, 'Transition state is required');
      try {
        const updated = await dependencies.service.transition(actor, requestId, { to: input.to as AssistanceState,
          ...(typeof input.owner_id === 'string' ? { ownerId: input.owner_id } : {}),
          ...(typeof input.reason === 'string' ? { reason: input.reason } : {}) });
        return Response.json(present(updated), { headers: { 'cache-control': 'no-store' } });
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (message === 'not_found') return problem(404, 'Not found');
        if (message === 'forbidden') return problem(403, 'Forbidden');
        return problem(409, 'Illegal transition');
      }
    },
  };
}

/** WP-004 session adapter: request headers never supply identity or roles. */
export function createSessionAuthenticator(session: (orgId: string, token: string) => Promise<Identity | null>, orgId: string) {
  return async (request: Request): Promise<Identity | null> => {
    const token = request.headers.get('cookie')?.split(';').map(value => value.trim()).find(value => value.startsWith('ss_session='))?.slice('ss_session='.length);
    return token ? session(orgId, decodeURIComponent(token)) : null;
  };
}
