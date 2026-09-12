import { isIP } from 'node:net';
import { authProblemTitles, type AuthProblemCode } from '@seniorsocial/i18n';
import {
  AuthService,
  PostgresAuthStore,
  createAuthDatabaseClient,
  assertConstrainedRuntimeRole,
  randomToken,
  type AuthSql,
  type EstablishedSession,
} from '../../../../../packages/auth/src/index';

export const SESSION_COOKIE = 'ss_session';
export const DEVICE_COOKIE = 'ss_auth_device';

export function isExplicitLocalMode(): boolean {
  return process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
}

export function configuredOrgId(request: Request): string {
  const configured = process.env.SENIORSOCIAL_ORG_ID;
  const localOverride = isExplicitLocalMode()
    ? request.headers.get('x-seniorsocial-org-id')
    : null;
  const orgId = configured ?? localOverride;
  if (!orgId) throw new Error('SENIORSOCIAL_ORG_ID is required');
  return orgId;
}

export function readCookie(request: Request, name: string): string | null {
  const cookies = request.headers.get('cookie')?.split(';') ?? [];
  for (const cookie of cookies) {
    const [key, ...value] = cookie.trim().split('=');
    if (key === name) {
      try {
        return decodeURIComponent(value.join('='));
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function browserNonce(request: Request): { value: string; isNew: boolean } {
  const current = readCookie(request, DEVICE_COOKIE);
  return current ? { value: current, isNew: false } : { value: randomToken(), isNew: true };
}

function cookieSecurity(): string {
  return isExplicitLocalMode() ? '' : '; Secure';
}

export function setDeviceCookie(response: Response, nonce: string): void {
  response.headers.append(
    'set-cookie',
    `${DEVICE_COOKIE}=${encodeURIComponent(nonce)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${cookieSecurity()}`,
  );
}

export function setSessionCookie(response: Response, session: EstablishedSession): void {
  const maxAge = Math.max(0, Math.floor((session.expiresAt.getTime() - Date.now()) / 1000));
  response.headers.append(
    'set-cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(session.token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${cookieSecurity()}`,
  );
}

export function clearSessionCookie(response: Response): void {
  response.headers.append(
    'set-cookie',
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${cookieSecurity()}`,
  );
}

export function problem(request: Request, status: number, code: AuthProblemCode): Response {
  const locale = readCookie(request, 'seniorsocial.locale.v1') === 'es' ? 'es' : 'en';
  return Response.json({ type: `urn:seniorsocial:problem:${code}`, code, title: authProblemTitles[locale][code], status }, {
    status,
    headers: { 'content-type': 'application/problem+json', 'content-language': locale },
  });
}

export async function jsonObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return typeof body === 'object' && body !== null && !Array.isArray(body)
      ? body as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export async function withAuthService<T>(orgId: string, work: (service: AuthService) => Promise<T>): Promise<T> {
  const pepper = process.env.AUTH_TOKEN_PEPPER;
  if (!pepper) throw new Error('AUTH_TOKEN_PEPPER is required');
  const client = createAuthDatabaseClient();
  try {
    const result = await client.begin(async transaction => {
      await assertConstrainedRuntimeRole(transaction as unknown as AuthSql);
      await transaction`select set_config('app.current_org_id', ${orgId}, true)`;
      const store = new PostgresAuthStore(transaction as unknown as AuthSql);
      const service = new AuthService(store, {
        pepper,
        exposeSimulationCredentials:
          isExplicitLocalMode() && process.env.AUTH_SIMULATION_EXPOSE_CREDENTIALS === 'true',
      });
      return work(service);
    });
    return result as T;
  } finally {
    await client.end();
  }
}

export function trustedRequestIp(request: Request): string {
  if (isExplicitLocalMode()) {
    const local = request.headers.get('x-auth-test-client-ip') ?? '127.0.0.1';
    if (isIP(local) === 0) throw new Error('invalid local auth test client IP');
    return local;
  }
  if (process.env.AUTH_TRUST_PROXY_HEADERS !== 'true') {
    throw new Error('AUTH_TRUST_PROXY_HEADERS=true is required outside development/test');
  }
  const forwarded = request.headers.get('x-forwarded-for');
  const clientIp = forwarded?.split(',')[0]?.trim();
  if (!clientIp || isIP(clientIp) === 0) throw new Error('trusted proxy client IP is missing or invalid');
  return clientIp;
}

export function tooManyRequests(request: Request, retryAfterSeconds: number): Response {
  const response = problem(request, 429, 'rate_limited');
  response.headers.set('retry-after', String(Math.max(1, retryAfterSeconds)));
  return response;
}
