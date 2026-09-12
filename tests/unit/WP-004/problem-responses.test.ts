import { describe, expect, it } from 'vitest';
import { POST as requestMagicLink } from '../../../apps/web/app/(auth)/auth/magic-link/route.ts';
import { GET as readSession } from '../../../apps/web/app/(auth)/auth/session/route.ts';
import { browserNonce, tooManyRequests } from '../../../apps/web/app/(auth)/auth/_shared.ts';

async function body(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>;
}

describe('WP-004 auth Problem responses', () => {
  it('uses a stable machine code and catalog-backed English title for invalid input', async () => {
    const response = await requestMagicLink(new Request('http://local/auth/magic-link', {
      method: 'POST', body: JSON.stringify({ email: 'not-an-email' }),
    }));
    expect(response.headers.get('content-language')).toBe('en');
    expect(await body(response)).toEqual({
      type: 'urn:seniorsocial:problem:invalid_request', code: 'invalid_request',
      title: 'Invalid request', status: 422,
    });
  });

  it('keeps session and throttle failures on stable non-display codes', async () => {
    expect(await body(await readSession(new Request('http://local/auth/session')))).toMatchObject({ code: 'session_required' });
    const throttled = tooManyRequests(new Request('http://local/auth/verify'), 7);
    expect(throttled.headers.get('retry-after')).toBe('7');
    expect(await body(throttled)).toMatchObject({ code: 'rate_limited', status: 429 });
  });

  it('treats malformed locale, session, and device cookies as absent instead of throwing', async () => {
    const invalidInput = await requestMagicLink(new Request('http://local/auth/magic-link', {
      method: 'POST', headers: { cookie: 'seniorsocial.locale.v1=%' }, body: '{}',
    }));
    expect(invalidInput.status).toBe(422);
    expect(invalidInput.headers.get('content-language')).toBe('en');
    expect(await body(invalidInput)).toMatchObject({ code: 'invalid_request', title: 'Invalid request' });

    const missingSession = await readSession(new Request('http://local/auth/session', {
      headers: { cookie: 'ss_session=%' },
    }));
    expect(missingSession.status).toBe(401);
    expect(await body(missingSession)).toMatchObject({ code: 'session_required' });

    expect(() => browserNonce(new Request('http://local/auth/verify', {
      headers: { cookie: 'ss_auth_device=%' },
    }))).not.toThrow();
    expect(browserNonce(new Request('http://local/auth/verify', {
      headers: { cookie: 'ss_auth_device=%' },
    })).isNew).toBe(true);
  });
});
