import { RateLimitError, validateCanonicalAuthInput } from '../../../../../../packages/auth/src/index';
import { browserNonce, configuredOrgId, jsonObject, problem, setDeviceCookie, tooManyRequests, trustedRequestIp, withAuthService } from '../_shared';

export async function POST(request: Request): Promise<Response> {
  const parsed = validateCanonicalAuthInput('SmsCodeRequest', await jsonObject(request));
  if (!parsed.success) return problem(request, 422, 'invalid_request');
  const orgId = configuredOrgId(request);
  const nonce = browserNonce(request);
  let result;
  try {
    result = await withAuthService(orgId, service => service.requestSmsCode(orgId, parsed.data.phone, nonce.value, trustedRequestIp(request)));
  } catch (error) {
    if (error instanceof RateLimitError) return tooManyRequests(request, error.retryAfterSeconds);
    throw error;
  }
  const response = Response.json(result, { status: 202 });
  if (nonce.isNew) setDeviceCookie(response, nonce.value);
  return response;
}
