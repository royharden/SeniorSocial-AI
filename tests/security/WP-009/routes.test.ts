import { expect, it } from 'vitest';
import { GET as inbox } from '../../../apps/web/app/api/v1/notifications/route.ts';
import { GET as preferences, PUT } from '../../../apps/web/app/api/v1/me/preferences/route.ts';
import { GET as print } from '../../../apps/web/app/api/v1/me/schedule/print/route.ts';

// what_bug_this_catches: a route silently uses a fallback resident or discloses data on malformed session cookies.
it('returns identical generic denials without a valid session', async () => {
  for (const handler of [inbox, preferences, print]) {
    for (const cookie of ['', 'ss_session=invalid', 'ss_session=%invalid']) {
      const response = await handler(new Request('http://localhost/api/v1/notifications', { headers: { cookie } }));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ type: 'about:blank', title: 'Unavailable', status: 403 });
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  }
});
// what_bug_this_catches: cross-origin preference writes reach authenticated state mutations.
it('rejects preference CSRF before mutation', async () => {
  const response = await PUT(new Request('http://localhost/api/v1/me/preferences', { method: 'PUT', headers: { origin: 'https://attacker.invalid' }, body: '{}' }));
  expect(response.status).toBe(403);
});
