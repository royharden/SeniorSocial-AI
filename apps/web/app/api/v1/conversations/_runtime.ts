import { createDatabaseClient } from '../../../../../../packages/db/src/index.ts';
import { createMessaging, MessagingError, wp009Notices, type Messaging, type MessagingIdentity } from '../../../../../../packages/messaging/src/index.ts';
import { configuredOrgId, readCookie, SESSION_COOKIE, withAuthService } from '../../../(auth)/auth/_shared';

export async function resolveIdentity(request: Request): Promise<MessagingIdentity | null> {
  try {
    const token = readCookie(request, SESSION_COOKIE);
    if (!token) return null;
    const org = configuredOrgId(request);
    const session = await withAuthService(org, auth => auth.session(org, token));
    return session && session.orgId === org ? { orgId: org, userId: session.userId } : null;
  } catch { return null; }
}
export async function run<T>(work: (service: Messaging) => Promise<T>): Promise<T> {
  const client = createDatabaseClient();
  try { return await work(createMessaging(client, wp009Notices)); } finally { await client.end(); }
}
export function problem(status: number) {
  return Response.json({ type: 'about:blank', title: status === 401 ? 'Authentication required' : status === 404 ? 'Not found' : status === 409 ? 'Conflict' : status === 422 ? 'Invalid input' : 'Unavailable', status },
    { status, headers: { 'cache-control': 'no-store', 'content-type': 'application/problem+json' } });
}
export interface RouteDependencies { identity(request: Request): Promise<MessagingIdentity | null>; run: typeof run }
const defaults: RouteDependencies = { identity: resolveIdentity, run };
export type Operation = 'list' | 'create' | 'messages' | 'send' | 'report' | 'block' | 'blocks';
/** Exported from a non-route file for identity-negative API tests. */
export function handler(operation: Operation, dependencies = defaults) {
  return async (request: Request, context?: { params?: Promise<{ conversationId: string }> }) => {
    try {
      const identity = await dependencies.identity(request);
      if (!identity) return problem(401);
      const mutation = ['create', 'send', 'report', 'block'].includes(operation);
      if (mutation && request.headers.get('origin') !== new URL(request.url).origin) return problem(403);
      let input: Record<string, unknown> = {};
      if (mutation) {
        // Reject oversized input and never echo a malformed submitted body.
        const body = await request.text();
        if (body.length > 24_000) return problem(422);
        try {
          const parsed: unknown = JSON.parse(body);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return problem(422);
          input = parsed as Record<string, unknown>;
        } catch { return problem(422); }
      }
      const id = context?.params ? (await context.params).conversationId : '';
      const key = request.headers.get('idempotency-key') ?? '';
      const value = await dependencies.run<unknown>(service => {
        switch (operation) {
          case 'list': return service.list(identity);
          case 'create': return service.create(identity, typeof input.participant_id === 'string' ? input.participant_id : '');
          case 'messages': return service.messages(identity, id);
          case 'send': return service.send(identity, id, input.body, key);
          case 'report': return service.report(identity, id, input, key);
          case 'block': return service.block(identity, typeof input.user_id === 'string' ? input.user_id : '');
          case 'blocks': return service.blocks(identity);
        }
      });
      return Response.json(value, { status: mutation ? 201 : 200, headers: { 'cache-control': 'no-store' } });
    } catch (error) { return problem(error instanceof MessagingError ? error.status : 503); }
  };
}
