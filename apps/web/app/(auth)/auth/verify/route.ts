import { validateCanonicalAuthInput } from '../../../../../../packages/auth/src/index';
import { browserNonce, configuredOrgId, jsonObject, problem, setDeviceCookie, setSessionCookie, tooManyRequests, trustedRequestIp, withAuthService } from '../_shared';

export async function POST(request: Request): Promise<Response> {
  const parsed = validateCanonicalAuthInput('VerifyRequest', await jsonObject(request));
  if (!parsed.success) return problem(request, 422, 'invalid_request');
  const nonce = browserNonce(request);
  const orgId = configuredOrgId(request);
  const result = await withAuthService(orgId, service => service.verify(
    orgId,
    parsed.data.method,
    parsed.data.credential,
    nonce.value,
    trustedRequestIp(request),
  ));
  if (!result.ok) {
    const response = result.reason === 'rate_limited'
      ? tooManyRequests(request, result.retryAfterSeconds)
      : problem(request, 401, 'invalid_credential');
    if (nonce.isNew) setDeviceCookie(response, nonce.value);
    return response;
  }
  const response = Response.json({
    user_id: result.value.userId,
    expires_at: result.value.expiresAt.toISOString(),
  });
  setSessionCookie(response, result.value);
  if (nonce.isNew) setDeviceCookie(response, nonce.value);
  return response;
}
