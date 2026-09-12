import { type Identity, withPostgresAssistanceService } from '../../../../../../packages/assistance/src/index.ts';
import { loadConfig } from '../../../../../../packages/config/src/index.ts';
import { configuredOrgId, readCookie, SESSION_COOKIE, withAuthService } from '../../../(auth)/auth/_shared';
import { createAssistanceHandlers } from './_route';

export async function withAssistanceRuntime(request: Request, operation: (handlers: ReturnType<typeof createAssistanceHandlers>) => Promise<Response>): Promise<Response> {
  const orgId = configuredOrgId(request);
  const token = readCookie(request, SESSION_COOKIE);
  const session = token ? await withAuthService(orgId, service => service.session(orgId, token)) : null;
  if (!session) return Response.json({ type: 'about:blank', title: 'Authentication required', status: 401 }, { status: 401 });
  const identity: Identity = { orgId: session.orgId, userId: session.userId, roles: session.roles };
  const key = process.env.ASSISTANCE_ENCRYPTION_KEY;
  if (!key) throw new Error('ASSISTANCE_ENCRYPTION_KEY is required');
  return withPostgresAssistanceService({ encryptionKey: key, timeZone: loadConfig().branding.cityTimezone },
    service => operation(createAssistanceHandlers({ authenticate: () => Promise.resolve(identity), service })));
}
