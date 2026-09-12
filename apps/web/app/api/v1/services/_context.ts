import type { SessionRecord } from '@seniorsocial/auth';
import { readCookie, SESSION_COOKIE, withAuthService } from '../../../(auth)/auth/_shared';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const operatorRoles = new Set(['staff', 'admin']);

export interface PublicServiceContext { readonly orgId: string }
export interface AdminServiceContext extends PublicServiceContext {
  readonly actorId: string;
  readonly roles: readonly string[];
}

export class ServiceContextUnavailable extends Error {}
export class ServiceForbidden extends Error {}

function requiredUuid(name: string): string {
  const value = process.env[name];
  if (!value || !uuid.test(value)) throw new ServiceContextUnavailable(`${name} is unavailable`);
  return value;
}

/**
 * Temporary server-only adapter until WP-004 provides authenticated request context.
 * Identity is never accepted from request headers, query parameters, or request bodies.
 */
export function publicServiceContext(): PublicServiceContext {
  return { orgId: requiredUuid('SENIORSOCIAL_ORG_ID') };
}

export function requireSameOrigin(request: Request): void {
  const url = new URL(request.url);
  const host = request.headers.get('host') ?? url.host;
  const expected = new URL(`${url.protocol}//${host}`).origin;
  if (request.headers.get('origin') !== expected) throw new ServiceForbidden('same-origin request required');
}

export async function adminServiceContext(request: Request): Promise<AdminServiceContext> {
  const orgId = requiredUuid('SENIORSOCIAL_ORG_ID');
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) throw new ServiceForbidden('authenticated session required');
  let session: SessionRecord | null;
  try { session = await withAuthService(orgId, service => service.session(orgId, token)); }
  catch { throw new ServiceContextUnavailable('authentication service is unavailable'); }
  if (!session || session.orgId !== orgId || !session.roles.some(role => operatorRoles.has(role))) {
    throw new ServiceForbidden('operator role required');
  }
  return { orgId, actorId: session.userId, roles: session.roles };
}
