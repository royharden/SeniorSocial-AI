import { configuredOrgId, problem, readCookie, SESSION_COOKIE, withAuthService } from '../_shared';

export async function GET(request: Request): Promise<Response> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return problem(request, 401, 'session_required');
  const orgId = configuredOrgId(request);
  const session = await withAuthService(orgId, service => service.session(orgId, token));
  if (!session) return problem(request, 401, 'invalid_session');
  return Response.json({
    user_id: session.userId,
    org_id: session.orgId,
    roles: session.roles,
    expires_at: session.expiresAt.toISOString(),
    demo_mode: session.isDemo,
  });
}
