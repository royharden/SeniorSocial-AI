import { configuredOrgId, readCookie, SESSION_COOKIE, withAuthService } from '../../../(auth)/auth/_shared';
import { createDatabaseClient } from '../../../../../../packages/db/src/index';
import type { Identity } from '../../../../../../packages/notify/src/types';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export async function resolveIdentity(request: Request): Promise<Identity | null> {
  try {
    const token = readCookie(request, SESSION_COOKIE);
    const org = configuredOrgId(request);
    if (!token || !uuid.test(org)) return null;
    const session = await withAuthService(org, service => service.session(org, token));
    return session && session.orgId === org && uuid.test(session.userId) ? { orgId: org, userId: session.userId } : null;
  } catch { return null; }
}
export const unavailable = () => Response.json({ type: 'about:blank', title: 'Unavailable', status: 403 }, { status: 403, headers: { 'cache-control': 'no-store' } });
export const json = (value: unknown) => Response.json(value, { headers: { 'cache-control': 'no-store' } });
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  return origin === new URL(request.url).origin;
}
export async function authenticated(request: Request, work: (identity: Identity, client: ReturnType<typeof createDatabaseClient>, recheck: () => Promise<void>) => Promise<Response>) {
  const identity = await resolveIdentity(request);
  if (!identity) return unavailable();
  const client = createDatabaseClient();
  try {
    return await work(identity, client, async () => {
      const current = await resolveIdentity(request);
      if (!current || current.orgId !== identity.orgId || current.userId !== identity.userId) throw new Error('Unavailable');
    });
  } catch { return unavailable(); } finally { await client.end(); }
}
