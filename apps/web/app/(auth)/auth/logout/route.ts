import { clearSessionCookie, configuredOrgId, readCookie, SESSION_COOKIE, withAuthService } from '../_shared';

export async function POST(request: Request): Promise<Response> {
  const token = readCookie(request, SESSION_COOKIE);
  if (token) {
    const orgId = configuredOrgId(request);
    await withAuthService(orgId, service => service.logout(orgId, token));
  }
  const response = new Response(null, { status: 204 });
  clearSessionCookie(response);
  return response;
}
