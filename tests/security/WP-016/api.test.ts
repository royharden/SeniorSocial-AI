import { describe, expect, it, vi } from 'vitest';
import { handler } from '../../../apps/web/app/api/v1/conversations/_runtime.ts';
import { createMessaging, MessagingError, wp009Notices, type Messaging } from '../../../packages/messaging/src/index.ts';
import type { DatabaseClient } from '../../../packages/db/src/index.ts';

describe('WP-016 API trust and data boundaries', () => {
  const identity = { orgId: '10000000-0000-4000-8000-000000000001', userId: '10000000-0000-4000-8000-000000000011' };
  const url = 'http://localhost/api/v1/conversations';
  it('does not invoke messaging for unauthenticated spoofed identity headers', async () => {
    const run = vi.fn();
    const response = await handler('send', { identity: () => Promise.resolve(null), run })(new Request(url, { method: 'POST', headers: { 'x-user-id': identity.userId, 'x-org-id': identity.orgId }, body: '{}' }));
    expect(response.status).toBe(401); expect(run).not.toHaveBeenCalled();
  });
  it('requires same-origin writes and never accepts JSON identity as authority', async () => {
    const send = vi.fn().mockResolvedValue({ id: 'message', body: 'native', sent_at: 'now' });
    const service = { send } as unknown as Messaging;
    const run = <T>(work: (value: Messaging) => Promise<T>) => work(service);
    const route = handler('send', { identity: () => Promise.resolve(identity), run });
    const context = { params: Promise.resolve({ conversationId: 'conversation' }) };
    const rejected = await route(new Request(url, { method: 'POST', headers: { origin: 'http://evil.invalid' }, body: '{}' }), context);
    expect(rejected.status).toBe(403); expect(send).not.toHaveBeenCalled();
    const response = await route(new Request(url, { method: 'POST', headers: { origin: 'http://localhost', 'idempotency-key': 'retry-key' },
      body: JSON.stringify({ body: 'native', orgId: 'forged', userId: 'forged' }) }), context);
    expect(response.status).toBe(201); expect(send).toHaveBeenCalledWith(identity, 'conversation', 'native', 'retry-key');
  });
  it('sanitizes all native-body-bearing exceptions and uses identical 404s for inaccessible IDs', async () => {
    for (const error of [new Error('PRIVATE_BODY_SECRET'), new MessagingError(404)]) {
      const response = await handler('messages', { identity: () => Promise.resolve(identity), run: () => Promise.reject(error) })(new Request(url));
      expect(response.status).toBe(error instanceof MessagingError ? 404 : 503);
      expect(await response.text()).not.toContain('PRIVATE_BODY_SECRET');
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  });
  it('rejects missing and malformed v5 keys for send and report without touching storage', async () => {
    const reserve = vi.fn().mockRejectedValue(new Error('Storage must not be reached'));
    const service = createMessaging({ reserve } as unknown as DatabaseClient, wp009Notices);
    const dependencies = { identity: () => Promise.resolve(identity), run: <T>(work: (value: Messaging) => Promise<T>) => work(service) };
    for (const operation of ['send', 'report'] as const) {
      const route = handler(operation, dependencies);
      for (const key of [null, '', 'old:colon', 'slash/key', 'space key', 'x'.repeat(161)]) {
        const headers = new Headers({ origin: 'http://localhost' });
        if (key !== null) headers.set('idempotency-key', key);
        const response = await route(new Request(url, { method: 'POST', headers, body: JSON.stringify({ body: 'Private', reason: 'Private' }) }),
          { params: Promise.resolve({ conversationId: identity.orgId }) });
        expect(response.status).toBe(422);
        expect(await response.text()).not.toContain('Private');
      }
    }
    expect(reserve).not.toHaveBeenCalled();
  });
});
