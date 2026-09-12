import { AuditRepository, auditActions } from '@seniorsocial/audit';
import { createDatabaseClient } from '@seniorsocial/db';
import { readCookie, SESSION_COOKIE, withAuthService } from '../../../../(auth)/auth/_shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export interface AdminAuditContext { orgId: string; roles: readonly string[] }
export interface AuditRouteDependencies {
  authorize: (request: Request) => Promise<AdminAuditContext | null>;
  audit: { list: (orgId: string, query: { action?: string; target?: string; cursor?: string; limit?: number }) => Promise<unknown> };
}

class AuditQueryError extends Error {}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const targetPattern = /^[a-z][a-z0-9_]*:[A-Za-z0-9._-]+$/u;
const actionSet = new Set<string>(auditActions);

function problem(status: 400 | 403 | 503, title: string, detail: string): Response {
  return Response.json({ type: 'about:blank', title, status, detail }, {
    status,
    headers: { 'cache-control': 'no-store', 'content-type': 'application/problem+json' },
  });
}

function one(query: URLSearchParams, name: string): string | undefined {
  const values = query.getAll(name);
  if (values.length > 1) throw new AuditQueryError(`${name} must appear at most once`);
  return values[0];
}

function parseQuery(request: Request): { action?: string; target?: string; cursor?: string; limit?: number } {
  const query = new URL(request.url).searchParams;
  const action = one(query, 'action');
  const target = one(query, 'target');
  const cursor = one(query, 'cursor');
  const rawLimit = one(query, 'limit');
  if (action !== undefined && (!actionSet.has(action) || action.length > 64)) throw new AuditQueryError('action is invalid');
  if (target !== undefined && (target.length > 300 || !targetPattern.test(target))) throw new AuditQueryError('target is invalid');
  if (cursor !== undefined) {
    const separator = cursor.lastIndexOf('|');
    const at = cursor.slice(0, separator);
    const id = cursor.slice(separator + 1);
    if (cursor.length > 100 || separator < 1 || Number.isNaN(Date.parse(at)) || !uuid.test(id)) throw new AuditQueryError('cursor is invalid');
  }
  let limit: number | undefined;
  if (rawLimit !== undefined) {
    if (!/^[1-9][0-9]{0,2}$/u.test(rawLimit)) throw new AuditQueryError('limit must be an integer from 1 to 100');
    limit = Number(rawLimit);
    if (limit > 100) throw new AuditQueryError('limit must be an integer from 1 to 100');
  }
  return {
    ...(action === undefined ? {} : { action }),
    ...(target === undefined ? {} : { target }),
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit }),
  };
}

export function createListAuditEventsHandler(dependencies: AuditRouteDependencies) {
  return async function get(request: Request): Promise<Response> {
    let context: AdminAuditContext | null;
    try { context = await dependencies.authorize(request); }
    catch { return problem(503, 'Audit events unavailable', 'Audit events are temporarily unavailable'); }
    if (!context?.roles.includes('admin')) {
      return problem(403, 'Forbidden', 'An explicit authenticated admin context is required');
    }
    let query: ReturnType<typeof parseQuery>;
    try { query = parseQuery(request); }
    catch (error) {
      return problem(400, 'Bad Request', error instanceof AuditQueryError ? error.message : 'Audit query is invalid');
    }
    try {
      const result = await dependencies.audit.list(context.orgId, query);
      return Response.json(result, { headers: { 'cache-control': 'no-store' } });
    } catch {
      return problem(503, 'Audit events unavailable', 'Audit events are temporarily unavailable');
    }
  };
}

async function authorizeFromSession(request: Request): Promise<AdminAuditContext | null> {
  const orgId = process.env.SENIORSOCIAL_ORG_ID;
  const token = readCookie(request, SESSION_COOKIE);
  if (!orgId || !uuid.test(orgId)) throw new Error('SENIORSOCIAL_ORG_ID is required');
  if (!token) return null;
  const session = await withAuthService(orgId, service => service.session(orgId, token));
  return session?.orgId === orgId ? { orgId, roles: session.roles } : null;
}

const live: AuditRouteDependencies = {
  authorize: authorizeFromSession,
  audit: {
    list: async (orgId, query) => {
      const client = createDatabaseClient();
      try { return await new AuditRepository(client).list(orgId, query); }
      finally { await client.end(); }
    },
  },
};

export const GET = createListAuditEventsHandler(live);
