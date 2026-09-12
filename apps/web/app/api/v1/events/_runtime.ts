import { DurableAuditSink } from '../../../../../../packages/audit/src/index.ts';
import { createDatabaseClient, withOrg } from '../../../../../../packages/db/src/index.ts';
import {
  createEvents, createPostgresEventRepository, createPostgresWp009ReminderScheduler,
  type EventIdentity, type EventsService,
} from '../../../../../../packages/events/src/index.ts';
import { createPolicy, createPostgresConsentRepository } from '../../../../../../packages/policy/src/index.ts';
import { configuredOrgId, readCookie, SESSION_COOKIE, withAuthService } from '../../../(auth)/auth/_shared';

export type EventRouteContext = EventIdentity;

export async function authenticated(request: Request): Promise<EventRouteContext | null> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const orgId = configuredOrgId(request);
  const session = await withAuthService(orgId, service => service.session(orgId, token));
  return session ? { orgId: session.orgId, userId: session.userId, roles: session.roles } : null;
}

export async function withEventRuntime<T>(work: (service: EventsService) => Promise<T>): Promise<T> {
  const client = createDatabaseClient();
  try {
    const repository = createPostgresEventRepository(client);
    const reminders = createPostgresWp009ReminderScheduler(client);
    const authorization = createPolicy(createPostgresConsentRepository(client), new DurableAuditSink(client));
    const orgTimeZone = { forOrg: (orgId: string) => withOrg(client, orgId, async sql => {
      const row = (await sql<{ timezone: string }[]>`select timezone from orgs where id = ${orgId}`)[0];
      if (!row) throw new Error('Organisation time zone unavailable');
      return row.timezone;
    }) };
    return await work(createEvents({ repository, reminders, authorization, orgTimeZone }));
  } finally {
    await client.end();
  }
}

export function problem(status: number, code: string): Response {
  const title = status === 401 ? 'Authentication required' : status === 409 ? 'Conflict' : status === 422 ? 'Unprocessable content' : 'Not found';
  return Response.json({ type: `urn:seniorsocial:problem:${code}`, title, status, code },
    { status, headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store' } });
}

export function resultResponse(result: unknown, successStatus = 200): Response {
  if (result && typeof result === 'object' && 'status' in result && typeof result.status === 'number') {
    const value = result as { status: number; code?: string };
    return problem(value.status, value.code ?? 'not_found');
  }
  return Response.json(result, { status: successStatus, headers: { 'cache-control': 'no-store' } });
}

export async function parseObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await request.json();
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}
