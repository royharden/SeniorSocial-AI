import { describe, expect, it } from 'vitest';
import { eventReminderNotice, minimalNotificationArtifact, nextDeliveryAt, parsePreferences, replacePreferences } from '../../../packages/notify/src/index.ts';
import { fixture, identity, optedIn, request } from './fixture.ts';

const conversationId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const messageSender = { ...identity, userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };

describe('WP-009 preference and outbox behavior', () => {
  // what_bug_this_catches: minimal bodies select unreviewed Spanish directly or lose the resolver decision needed to audit rendering.
  it('renders minimal bodies through the governed catalog with explicit provenance', () => {
    const english = minimalNotificationArtifact('en');
    expect(english).toMatchObject({
      body: 'You have a new notification. Sign in securely.',
      catalogKey: 'body.minimal', requestedLocale: 'en', renderedLocale: 'en',
      renderState: 'english_source', reviewStatus: 'draft',
    });
    expect(english.sourceVersion).toMatch(/^sha256:[a-f0-9]{64}$/u);
    const heldSpanish = minimalNotificationArtifact('es');
    expect(heldSpanish).toMatchObject({
      requestedLocale: 'es', renderedLocale: 'en',
      renderState: 'provisional_english_fallback', reviewStatus: 'draft',
      sourceVersion: english.sourceVersion,
    });
    expect(heldSpanish.body).toBe('You have a new notification. Sign in securely.\n\nSpanish translation is awaiting review.');
    expect(heldSpanish.body).not.toContain('Tiene una nueva notificación');
  });

  // what_bug_this_catches: a shared-phone SMS bypasses the approval resolver and leaks the normal renderer body.
  it('uses the governed content-free artifact for shared non-email devices', async () => {
    const f = fixture();
    await f.service.replace(identity, { ...optedIn(), locale: 'es', shared_device: true });
    const queued = await f.service.enqueue(identity, request);
    if (!('id' in queued)) throw new Error('Expected job');
    await f.service.send(identity, queued.id);
    expect(f.deps.renderer.body).not.toHaveBeenCalled();
    expect(f.deps.adapter.send).toHaveBeenCalledWith(expect.objectContaining({
      body: minimalNotificationArtifact('es').body,
      channel: 'sms',
    }));
    expect(JSON.stringify(f.deps.adapter.send.mock.calls)).not.toContain('private resident content');
  });

  it('renders event-specific inbox copy in the selected resident language', () => {
    const eventId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const english = eventReminderNotice(eventId, 'en');
    expect(english.title).toBe('Event reminder');
    expect(english.body).toContain(eventId);
    const spanish = eventReminderNotice(eventId, 'es');
    expect(spanish.title).toBe('Recordatorio de evento');
    expect(spanish.body).toContain(eventId);
    expect(`${spanish.title} ${spanish.body}`).not.toMatch(/\breminder\b/iu);
    expect(spanish.body).toContain('Borrador automático, todavía no revisado por una persona.');
  });
  // what_bug_this_catches: a confirmed event reminder remains stranded in the
  // outbound table, or multiple enabled channels create duplicate inbox cards.
  it('transfers only confirmed event delivery to one logical resident inbox source', async () => {
    const f = fixture();
    await f.service.replace(identity, { ...optedIn(), channels: { event_reminder: { email: true, sms: true } } });
    const eventId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    f.deps.authorization.canNotify.mockImplementation((_actor,_recipient,purpose,resourceId)=>
      Promise.resolve(purpose === 'event_reminder' && resourceId === eventId));
    const base = { ...request, purpose: 'event_reminder' as const, template: 'event.reminder', params: { event_id: eventId } };
    const email = await f.service.enqueue(identity, { ...base, channel: 'email', idempotencyKey: 'event-email' });
    const sms = await f.service.enqueue(identity, { ...base, channel: 'sms', idempotencyKey: 'event-sms' });
    if (!('id' in email) || !('id' in sms)) throw new Error('Expected event jobs');
    await f.service.send(identity,email.id); await f.service.send(identity,sms.id);
    expect(f.deps.inbox.publish).toHaveBeenCalledTimes(2);
    expect(new Set(f.deps.inbox.publish.mock.calls.map(call => call[1]))).toEqual(new Set([`event-reminder:${eventId}`]));
    expect(f.deps.inbox.publish).toHaveBeenCalledWith(identity,`event-reminder:${eventId}`,expect.objectContaining({purpose:'event_reminder'}));
  });

  // what_bug_this_catches: stale RSVP authority reaches either the adapter or
  // the private inbox, or an inbox outage causes a duplicate outbound send.
  it('rechecks event participation before delivery and retries only inbox transfer', async () => {
    const f = fixture();
    await f.service.replace(identity, { ...optedIn(), channels: { event_reminder: { email: true } } });
    const eventId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const queued = await f.service.enqueue(identity,{...request,purpose:'event_reminder',channel:'email',template:'event.reminder',params:{event_id:eventId}});
    if (!('id' in queued)) throw new Error('Expected event job');
    f.deps.authorization.canNotify.mockResolvedValue(false);
    expect(await f.service.send(identity,queued.id)).toMatchObject({status:'suppressed'});
    expect(f.deps.adapter.send).not.toHaveBeenCalled(); expect(f.deps.inbox.publish).not.toHaveBeenCalled();

    const retry = fixture();
    await retry.service.replace(identity, { ...optedIn(), channels: { event_reminder: { email: true } } });
    const pending = await retry.service.enqueue(identity,{...request,purpose:'event_reminder',channel:'email',template:'event.reminder',params:{event_id:eventId}});
    if (!('id' in pending)) throw new Error('Expected event job');
    retry.deps.inbox.publish.mockRejectedValueOnce(new Error('inbox unavailable'));
    await expect(retry.service.send(identity,pending.id)).rejects.toThrow('inbox unavailable');
    expect(retry.repository.jobs.get(pending.id)?.state).toBe('delivered');
    expect(retry.deps.adapter.send).toHaveBeenCalledTimes(1);
    // Queue retries can be exhausted or lost after delivery committed. Durable
    // startup recovery must still complete the inbox transfer without resend.
    retry.deps.queue.enqueue.mockClear();
    await retry.service.recover(identity);
    expect(retry.deps.queue.enqueue).not.toHaveBeenCalled();
    expect(retry.deps.adapter.send).toHaveBeenCalledTimes(1);
    expect(retry.deps.inbox.publish).toHaveBeenCalledTimes(2);
  });

  // what_bug_this_catches: message delivery either impersonates the recipient or loses the conversation needed for a fresh block/participation check.
  it('preserves sender identity and the trusted conversation locator across enqueue and send authorization', async () => {
    const f = fixture();
    await f.service.replace(identity, { ...optedIn(), channels: { message: { email: true } } });
    f.deps.authorization.canNotify.mockImplementation((_actor, _recipient, purpose, resourceId) =>
      Promise.resolve(purpose === 'message' && resourceId === conversationId));
    const queued = await f.service.enqueue(messageSender, { ...request, recipientId: identity.userId, purpose: 'message',
      channel: 'email', resourceId: conversationId, template: 'message.notice' });
    if (!('id' in queued)) throw new Error('Expected job');
    expect(f.repository.jobs.get(queued.id)?.actorId).toBe(messageSender.userId);
    expect(f.repository.jobs.get(queued.id)?.payload.resource_id).toBe(conversationId);
    expect(await f.service.send(identity, queued.id)).toMatchObject({ status: 'delivered' });
    expect(f.deps.authorization.canNotify).toHaveBeenLastCalledWith(messageSender, identity.userId, 'message', conversationId);
  });

  // what_bug_this_catches: a message notice without a conversation locator bypasses fresh participant/block authorization.
  it('suppresses message notices that omit their authorization resource', async () => {
    const f = fixture();
    f.deps.authorization.canNotify.mockResolvedValue(true);
    expect(await f.service.enqueue(messageSender, { ...request, recipientId: identity.userId, purpose: 'message', channel: 'email' }))
      .toEqual({ status: 'suppressed' });
    expect(f.repository.jobs.size).toBe(0);
  });
  // what_bug_this_catches: a sink failure after the durable claim strands a definitely-unsent sending job.
  it('finishes delivery before propagating an audit outage at the claimed-send boundary', async () => {
    const f = fixture();
    await f.service.replace(identity, optedIn());
    const queued = await f.service.enqueue(identity, request);
    if (!('id' in queued)) throw new Error('Expected job');
    f.deps.audit.emit.mockRejectedValueOnce(new Error('claim audit unavailable'));
    await expect(f.service.send(identity, queued.id)).rejects.toThrow('claim audit unavailable');
    expect(f.deps.adapter.send).toHaveBeenCalledTimes(1);
    expect(f.repository.jobs.get(queued.id)?.state).toBe('delivered');
    expect(f.repository.attempts.map(a => a.outcome)).toEqual(['started', 'confirmed']);
    expect(f.repository.audits.length).toBeGreaterThan(0);
    await f.service.recover(identity);
    await f.service.send(identity, queued.id);
    expect(f.repository.audits).toHaveLength(0);
    expect(f.deps.adapter.send).toHaveBeenCalledTimes(1);
  });
  // what_bug_this_catches: a continuing audit outage blocks scheduling recovery for a definitely-unsent failure.
  it('schedules a known-unsent retry even while the audit sink remains unavailable', async () => {
    const f = fixture();
    await f.service.replace(identity, optedIn());
    const queued = await f.service.enqueue(identity, request);
    if (!('id' in queued)) throw new Error('Expected job');
    f.deps.audit.emit.mockRejectedValue(new Error('audit down'));
    f.deps.renderer.destination.mockRejectedValueOnce(new Error('render down'));
    await expect(f.service.send(identity, queued.id)).rejects.toThrow('audit down');
    expect(f.repository.jobs.get(queued.id)?.state).toBe('send_failed');
    expect(f.deps.adapter.send).not.toHaveBeenCalled();
    expect(f.deps.queue.enqueue).toHaveBeenCalledTimes(2);
    await expect(f.service.recover(identity)).rejects.toThrow('audit down');
    expect(f.deps.queue.enqueue).toHaveBeenCalledTimes(3);
  });
  // what_bug_this_catches: pre-adapter render errors are falsely called ambiguous and cannot retry.
  it.each(['destination', 'body'] as const)('retries a definitely-unsent %s failure without invoking the adapter', async stage => {
    const f = fixture();
    await f.service.replace(identity, optedIn());
    const queued = await f.service.enqueue(identity, request);
    if (!('id' in queued)) throw new Error('Expected job');
    f.deps.renderer[stage].mockRejectedValueOnce(new Error('renderer unavailable'));
    expect(await f.service.send(identity, queued.id)).toMatchObject({ status: 'send_failed' });
    expect(f.repository.jobs.get(queued.id)?.state).toBe('send_failed');
    expect(f.deps.adapter.send).not.toHaveBeenCalled();
    f.setNow('2026-09-10T16:01:00Z');
    expect(await f.service.send(identity, queued.id)).toMatchObject({ status: 'delivered' });
    expect(f.deps.adapter.send).toHaveBeenCalledTimes(1);
    expect(f.repository.attempts.map(a => a.outcome)).toEqual(['started', 'failed', 'started', 'confirmed']);
  });
  // what_bug_this_catches: an unrelated full-form update clears required task notices or revives a refusal.
  it('preserves omitted purpose/channel choices and requires explicit opt-in to undo refusal', () => {
    const original = { ...optedIn(), channels: { task_notice: { sms: true }, forums_digest: { email: false } } };
    const changed = replacePreferences(original, { ...optedIn(), channels: { recommendations: { email: true } } });
    expect(changed.channels).toEqual({ task_notice: { sms: true }, forums_digest: { email: false }, recommendations: { email: true } });
    expect(replacePreferences(changed, { ...optedIn(), channels: { forums_digest: { email: true } } }).channels.forums_digest?.email).toBe(true);
  });
  // what_bug_this_catches: JavaScript truthiness turns malicious boolean strings or unknown purposes into opt-ins.
  it('rejects malformed channel maps and quiet windows', () => {
    for (const channels of [{ task_notice: { sms: 'false' } }, { unrecognized: { sms: true } }, { task_notice: { fax: true } }]) {
      expect(() => parsePreferences({ ...optedIn(), channels })).toThrow();
    }
    for (const quiet_hours of [{ start: '25:00', end: '07:00', timezone: 'UTC' }, { start: '22:00' }, { start: '22:00', end: '07:00', timezone: 'No/Such_Zone' }]) {
      expect(() => parsePreferences({ ...optedIn(), quiet_hours })).toThrow();
    }
  });
  // what_bug_this_catches: no-outbound merely marks jobs skipped after creating them.
  it('creates zero jobs or queue calls for default and explicit no-outbound', async () => {
    const f = fixture();
    expect(await f.service.enqueue(identity, request)).toEqual({ status: 'suppressed' });
    await f.service.replace(identity, { ...optedIn(), no_outbound: true });
    await f.service.enqueue(identity, request);
    expect(f.repository.jobs.size).toBe(0);
    expect(f.deps.queue.enqueue).not.toHaveBeenCalled();
    expect(f.deps.renderer.body).not.toHaveBeenCalled();
  });
  // what_bug_this_catches: a single UTC offset mishandles spring-forward gaps and repeated autumn hours.
  it('defers through DST gaps, folds, overnight and daytime windows', () => {
    const prefs = { ...optedIn(), quiet_hours: { start: '22:00', end: '02:30', timezone: 'America/New_York' } };
    expect(nextDeliveryAt(new Date('2026-03-08T06:30:00Z'), prefs, 'task_notice').toISOString()).toBe('2026-03-08T07:00:00.000Z');
    const fall = { ...prefs, quiet_hours: { ...prefs.quiet_hours, end: '01:30' } };
    expect(nextDeliveryAt(new Date('2026-11-01T06:10:00Z'), fall, 'task_notice').toISOString()).toBe('2026-11-01T06:30:00.000Z');
    const daytime = { ...prefs, quiet_hours: { start: '09:00', end: '17:00', timezone: 'UTC' } };
    expect(nextDeliveryAt(new Date('2026-09-10T12:00:42Z'), daytime, 'task_notice').toISOString()).toBe('2026-09-10T17:00:00.000Z');
    expect(nextDeliveryAt(new Date('2026-09-10T12:00:42Z'), daytime, 'urgent_assistance').toISOString()).toBe('2026-09-10T12:00:42.000Z');
  });
  // what_bug_this_catches: quiet jobs disappear, or a queued preference change is ignored at send.
  it('retains one deferred job and respects a later no-outbound choice', async () => {
    const f = fixture();
    await f.service.replace(identity, { ...optedIn(), quiet_hours: { start: '09:00', end: '17:00', timezone: 'UTC' } });
    const queued = await f.service.enqueue(identity, request);
    if (!('id' in queued)) throw new Error('Expected job');
    await f.service.send(identity, queued.id);
    expect(f.deps.adapter.send).not.toHaveBeenCalled();
    expect(f.repository.jobs.get(queued.id)?.dueAt.toISOString()).toBe('2026-09-10T17:00:00.000Z');
    f.setNow('2026-09-10T17:00:00Z');
    await f.service.replace(identity, { ...optedIn(), no_outbound: true });
    expect(await f.service.send(identity, queued.id)).toMatchObject({ status: 'suppressed' });
    expect(f.deps.adapter.send).not.toHaveBeenCalled();
    expect(f.repository.jobs.size).toBe(1);
  });
  // what_bug_this_catches: racing duplicate enqueue/send creates multiple messages or missing committed audit.
  it('deduplicates concurrent enqueue and delivery; emits content-free audit only after commit', async () => {
    const f = fixture();
    await f.service.replace(identity, optedIn());
    const queued = await f.service.enqueue(identity, request);
    await f.service.enqueue(identity, { ...request, params: { detail: 'different private detail' } });
    if (!('id' in queued)) throw new Error('Expected job');
    await Promise.all([f.service.send(identity, queued.id), f.service.send(identity, queued.id)]);
    expect(f.repository.jobs.size).toBe(1);
    expect(f.deps.adapter.send).toHaveBeenCalledTimes(1);
    expect(f.repository.jobs.get(queued.id)?.state).toBe('delivered');
    expect(f.repository.attempts.map(a => a.outcome)).toEqual(['started', 'confirmed']);
    expect(JSON.stringify(f.intents)).not.toContain('private');
    expect(f.intents.map(i => i.action)).toContain('notification.queued');
  });
  // what_bug_this_catches: an ambiguous adapter error triggers automatic resend and falsely reports delivery.
  it('never automatically retries ambiguous delivery', async () => {
    const f = fixture();
    await f.service.replace(identity, optedIn());
    const queued = await f.service.enqueue(identity, request);
    if (!('id' in queued)) throw new Error('Expected job');
    f.deps.adapter.send.mockRejectedValue(new Error('accepted then connection lost'));
    expect(await f.service.send(identity, queued.id)).toMatchObject({ status: 'ambiguous', synthetic: true });
    f.setNow('2026-09-10T18:00:00Z');
    await f.service.send(identity, queued.id);
    expect(f.deps.adapter.send).toHaveBeenCalledTimes(1);
  });
  // what_bug_this_catches: retry creates a new id/key or a failed send advances to delivered without confirmation.
  it('retries confirmed rejection using the same key, after backoff', async () => {
    const f = fixture();
    await f.service.replace(identity, optedIn());
    const queued = await f.service.enqueue(identity, request);
    if (!('id' in queued)) throw new Error('Expected job');
    f.deps.adapter.send.mockResolvedValueOnce({ outcome: 'failed', synthetic: true });
    expect(await f.service.send(identity, queued.id)).toMatchObject({ status: 'send_failed' });
    await f.service.send(identity, queued.id);
    expect(f.deps.adapter.send).toHaveBeenCalledTimes(1);
    f.setNow('2026-09-10T16:01:00Z');
    expect(await f.service.send(identity, queued.id)).toMatchObject({ status: 'delivered', synthetic: true });
    expect(new Set(f.deps.adapter.send.mock.calls.map(([d]) => d.idempotencyKey)).size).toBe(1);
    expect(f.repository.attempts.map(a => a.outcome)).toEqual(['started', 'failed', 'started', 'confirmed']);
  });
  // what_bug_this_catches: queue or audit outage rolls back the durable intent, losing a notice forever.
  it('recovers a durable queue and audit intent after bridge failures', async () => {
    const f = fixture();
    await f.service.replace(identity, optedIn());
    f.deps.audit.emit.mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(f.service.enqueue(identity, request)).rejects.toThrow('audit unavailable');
    expect(f.repository.jobs.size).toBe(1);
    expect(f.repository.audits).toHaveLength(1);
    f.deps.queue.enqueue.mockRejectedValueOnce(new Error('queue unavailable'));
    await expect(f.service.recover(identity)).rejects.toThrow('queue unavailable');
    await f.service.recover(identity);
    expect(f.repository.audits).toHaveLength(0);
    expect(f.deps.queue.enqueue).toHaveBeenCalledTimes(2);
  });
});
