import { describe, expect, it } from 'vitest';
import { schemas } from '../../../packages/contracts/src/index.ts';
import { handler } from '../../../apps/web/app/api/v1/conversations/_runtime.ts';
import { createMessaging, wp009Notices, type Messaging } from '../../../packages/messaging/src/index.ts';
import type { DatabaseClient } from '../../../packages/db/src/index.ts';

describe('WP-016 immutable response contracts', () => {
  it('returns canonical participant/message/report shapes and statuses', async () => {
    const id = '10000000-0000-4000-8000-000000000001';
    const conversation = { id, participant_ids: [id, '10000000-0000-4000-8000-000000000002'] };
    const message = { id, body: 'Native message', sent_at: '2026-09-10T12:00:00Z' };
    const report = { id, state: 'open' };
    const service = { create: () => Promise.resolve(conversation), send: () => Promise.resolve(message), report: () => Promise.resolve(report) } as unknown as Messaging;
    const dependencies = { identity: () => Promise.resolve({ orgId: id, userId: id }), run: <T>(work: (s: Messaging) => Promise<T>) => work(service) };
    for (const [operation, schema] of [['create', schemas.Conversation], ['send', schemas.Message], ['report', schemas.Report]] as const) {
      const response = await handler(operation, dependencies)(new Request('http://localhost/api/v1/conversations', { method: 'POST', headers: { origin: 'http://localhost', 'idempotency-key': 'contract.v5~key' }, body: '{}' }), {});
      expect(response.status).toBe(201); expect(schema.safeParse(await response.json()).success).toBe(true);
    }
  });
  it('accepts the complete v5 header vocabulary for both mutations before storage', async () => {
    let storageReached = 0;
    const client = { reserve: () => { storageReached++; return Promise.reject(new Error('Synthetic database unavailable')); } } as unknown as DatabaseClient;
    const service = createMessaging(client, wp009Notices);
    const id = '10000000-0000-4000-8000-000000000001';
    const identity = { orgId: id, userId: id };
    for (const key of ['a.b~c_d-e', '.', '~', 'x'.repeat(160)]) {
      await expect(service.send(identity, id, 'Body', key)).rejects.toMatchObject({ status: 503 });
      await expect(service.report(identity, id, { reason: 'Reason' }, key)).rejects.toMatchObject({ status: 503 });
    }
    expect(storageReached).toBe(8);
  });
});
