import { describe, expect, it, vi } from 'vitest';
import { createBossQueue, createConsumer, validPayload } from '../../../packages/worker/src/bridge.ts';
import { fixture, identity, optedIn, otherOrg, request } from './fixture.ts';

describe('WP-009 queue boundary', () => {
  // what_bug_this_catches: replayed publication or retry claims a second outbound delivery.
  it('uses canonical singleton identity and delivers once across repeated jobs', async () => {
    const f = fixture();
    await f.service.replace(identity, optedIn());
    await f.service.enqueue(identity, request);
    const job = [...f.repository.jobs.values()][0]!;
    const send = vi.fn(() => Promise.resolve('queue-id'));
    const queue = createBossQueue({ send });
    await queue.enqueue('notify.send.sms', job.payload, job.dueAt);
    expect(send).toHaveBeenCalledWith('notify.send.sms', job.payload, expect.objectContaining({ singletonKey: job.payload.idempotency_key }));
    const consume = createConsumer({ find: (scope, channel, payload) => Promise.resolve(scope.orgId === job.orgId && scope.userId === job.userId && channel === job.channel && JSON.stringify(payload) === JSON.stringify(job.payload) ? job.id : null) }, f.service, identity.orgId);
    await Promise.all([consume('notify.send.sms', job.payload), consume('notify.send.sms', job.payload)]);
    await consume('notify.send.sms', job.payload);
    expect(f.deps.adapter.send).toHaveBeenCalledTimes(1);
    expect(f.repository.jobs.get(job.id)?.state).toBe('delivered');
    await expect(consume('notify.send.sms', { ...job.payload, org_id: otherOrg })).rejects.toThrow('Notification unavailable');
    await expect(consume('notify.send.email', job.payload)).rejects.toThrow('Notification unavailable');
    expect(f.deps.adapter.send).toHaveBeenCalledTimes(1);
  });
  // what_bug_this_catches: malformed tenant payload reaches lookup and mutates an arbitrary job.
  it('rejects malformed identity before lookup', async () => {
    const lookup = { find: vi.fn(() => Promise.resolve(null)) };
    const f = fixture();
    const consume = createConsumer(lookup, f.service, identity.orgId);
    for (const input of [null, {}, [], { org_id: 'invalid', user_id: identity.userId }]) {
      expect(validPayload(input)).toBe(false);
      await expect(consume('notify.send.sms', input)).rejects.toThrow('Notification unavailable');
    }
    expect(lookup.find).not.toHaveBeenCalled();
    expect(f.repository.attempts).toHaveLength(0);
  });
  // what_bug_this_catches: a sink outage acknowledges and loses the committed intent.
  it('retains pending intents on sink failure and correlates retry with their stable IDs', async () => {
    const f = fixture();
    f.deps.audit.emit.mockRejectedValueOnce(new Error('sink offline'));
    await expect(f.service.replace(identity, optedIn())).rejects.toThrow('sink offline');
    const pending = await f.repository.pendingAudits(identity);
    expect(pending).toHaveLength(1);
    await f.service.flushAudit(identity);
    expect(f.deps.audit.emit).toHaveBeenLastCalledWith(pending[0]!.intent, pending[0]!.id);
    expect(await f.repository.pendingAudits(identity)).toHaveLength(0);
  });
});
