import { describe, expect, it, vi } from 'vitest';
import { createEvents, createReminderScheduler, formatEventDateTime, MemoryEventRepository, zonedLocalDateTimeToIso, type EventIdentity, type EventJobPayload, type EventManageAccessRequest } from '../../../packages/events/src/index.ts';

const org = '10000000-0000-4000-8000-000000000001';
const otherOrg = '20000000-0000-4000-8000-000000000001';
const alice: EventIdentity = { orgId: org, userId: '10000000-0000-4000-8000-000000000011', roles: ['senior'] };
const bob: EventIdentity = { orgId: org, userId: '10000000-0000-4000-8000-000000000012', roles: ['senior'] };
const carol: EventIdentity = { orgId: org, userId: '10000000-0000-4000-8000-000000000013', roles: ['senior'] };
const staff: EventIdentity = { orgId: org, userId: '10000000-0000-4000-8000-000000000021', roles: ['staff'] };
const now = new Date('2026-09-10T12:00:00.000Z');

function fixture(capacity: number | null = 1) {
  const repository = new MemoryEventRepository('America/New_York');
  const event = repository.seed({ orgId: org, title: 'Community lunch', startsAt: new Date('2026-09-14T16:00:00.000Z'), location: 'Civic Hall', capacity, accessibility: ['step-free'] });
  const jobs = new Map<string, EventJobPayload>();
  const queue = { enqueue: vi.fn((_name: 'events.reminder.schedule', payload: EventJobPayload) => { jobs.set(payload.idempotency_key, payload); return Promise.resolve(); }) };
  const authorization = { authorize: vi.fn((request: EventManageAccessRequest) => Promise.resolve(request.actor.roles.includes('staff') || request.actor.roles.includes('admin') ?
    { allowed: true as const } : { allowed: false as const, status: 404 as const, error: 'not_found' as const })) };
  const orgTimeZone = { forOrg: vi.fn(() => Promise.resolve('America/New_York')) };
  const service = createEvents({ repository, reminders: createReminderScheduler(queue), authorization, orgTimeZone, clock: () => now });
  return { repository, event, jobs, queue, authorization, orgTimeZone, service };
}

describe('WP-012 event state machine', () => {
  // what_bug_this_catches: two requests both observe the last seat and overbook it.
  it('admits exactly one of two concurrent final-seat RSVPs', async () => {
    const f = fixture(1);
    const results = await Promise.all([f.service.rsvp(alice, f.event.id), f.service.rsvp(bob, f.event.id)]);
    expect(results.filter((result: Awaited<ReturnType<typeof f.service.rsvp>>) => !('status' in result))).toHaveLength(1);
    expect(results.filter((result: Awaited<ReturnType<typeof f.service.rsvp>>) => 'status' in result && result.status === 409)).toHaveLength(1);
    expect([...f.repository.rsvps.values()].filter(rsvp => rsvp.state === 'attending')).toHaveLength(1);
  });

  // what_bug_this_catches: retry inserts another RSVP or creates another logical reminder.
  it('makes RSVP and reminder scheduling idempotent', async () => {
    const f = fixture(2);
    const first = await f.service.rsvp(alice, f.event.id);
    const second = await f.service.rsvp(alice, f.event.id);
    expect(first).toEqual(second);
    expect(f.repository.rsvps.size).toBe(1);
    expect(f.jobs.size).toBe(1);
    expect([...f.jobs.values()][0]).toMatchObject({ org_id: org, user_id: alice.userId, event_id: f.event.id, purpose: 'event_reminder' });
  });

  // what_bug_this_catches: the RSVP commits but a queue outage loses its reminder forever.
  it('keeps a durable reminder intent after drain failure and recovers it once', async () => {
    const f = fixture(2);
    f.queue.enqueue.mockRejectedValueOnce(new Error('queue unavailable'));
    await expect(f.service.rsvp(alice, f.event.id)).rejects.toThrow('queue unavailable');
    expect([...f.repository.rsvps.values()].find(item => item.userId === alice.userId)?.state).toBe('attending');
    expect([...f.repository.reminderIntents.values()].filter(intent => intent.state === 'pending')).toHaveLength(1);
    await f.service.recoverReminders(alice);
    await f.service.recoverReminders(alice);
    expect(f.jobs.size).toBe(1);
    expect([...f.repository.reminderIntents.values()].filter(intent => intent.state === 'pending')).toHaveLength(0);
  });

  // what_bug_this_catches: duplicate cancellation skips or doubly promotes the oldest waiter.
  it('promotes the earliest waiter exactly once and schedules their reminder', async () => {
    const f = fixture(1);
    await f.service.rsvp(alice, f.event.id);
    await f.service.waitlist(bob, f.event.id);
    await new Promise(resolve => setTimeout(resolve, 2));
    await f.service.waitlist(carol, f.event.id);
    expect(await f.service.cancel(alice, f.event.id)).toEqual({ cancelled: true });
    expect(await f.service.cancel(alice, f.event.id)).toEqual({ cancelled: false });
    const bobRsvp = [...f.repository.rsvps.values()].find(item => item.userId === bob.userId);
    const carolRsvp = [...f.repository.rsvps.values()].find(item => item.userId === carol.userId);
    expect(bobRsvp?.state).toBe('attending');
    expect(carolRsvp?.state).toBe('waitlisted');
    expect([...f.jobs.values()].filter(job => job.user_id === bob.userId)).toHaveLength(1);
  });

  // what_bug_this_catches: two concurrent retries of one cancellation each promote a waiter,
  // releasing two seats for a single cancelled RSVP and scheduling two promotion reminders.
  it('serializes duplicate concurrent cancellation and promotes only one waiter', async () => {
    const f = fixture(1);
    await f.service.rsvp(alice, f.event.id);
    await f.service.waitlist(bob, f.event.id);
    await new Promise(resolve => setTimeout(resolve, 2));
    await f.service.waitlist(carol, f.event.id);

    const results = await Promise.all([
      f.service.cancel(alice, f.event.id),
      f.service.cancel(alice, f.event.id),
    ]);

    expect(results.filter(result => 'cancelled' in result && result.cancelled)).toHaveLength(1);
    expect(results.filter(result => 'cancelled' in result && !result.cancelled)).toHaveLength(1);
    expect([...f.repository.rsvps.values()].filter(rsvp => rsvp.state === 'attending')).toHaveLength(1);
    expect([...f.repository.rsvps.values()].find(rsvp => rsvp.userId === bob.userId)?.state).toBe('attending');
    expect([...f.repository.rsvps.values()].find(rsvp => rsvp.userId === carol.userId)?.state).toBe('waitlisted');
    expect([...f.jobs.values()].filter(job => job.user_id === bob.userId)).toHaveLength(1);
    expect([...f.jobs.values()].filter(job => job.user_id === carol.userId)).toHaveLength(0);
  });

  // what_bug_this_catches: proposal creation accidentally makes resident content public.
  it('keeps proposals unpublished until an authorized staff operation', async () => {
    const f = fixture();
    const proposal = await f.service.propose(alice, { title: 'Chess afternoon', starts_at: '2026-09-20T17:00:00.000Z' });
    if ('status' in proposal) throw new Error('expected proposal');
    const before = await f.service.list(alice);
    if ('status' in before) throw new Error('expected event page');
    expect(before.items.map(item => item.title)).not.toContain('Chess afternoon');
    expect(await f.service.publish(alice, proposal.id)).toEqual({ status: 404, code: 'not_found' });
    const request = f.authorization.authorize.mock.calls[0]?.[0];
    expect(request?.action).toBe('manage');
    expect(request?.resource).toMatchObject({ id: proposal.id, kind: 'event' });
    const published = await f.service.publish(staff, proposal.id, { location: 'Library', capacity: 8 });
    expect('title' in published && published.title).toBe('Chess afternoon');
    const after = await f.service.list(alice);
    if ('status' in after) throw new Error('expected event page');
    expect(after.items.map(item => item.title)).toContain('Chess afternoon');
  });

  it('fails publication closed when the policy dependency denies staff', async () => {
    const f = fixture();
    const proposal = await f.service.propose(alice, { title: 'Policy test', starts_at: '2026-09-20T17:00:00.000Z' });
    if ('status' in proposal) throw new Error('expected proposal');
    f.authorization.authorize.mockResolvedValueOnce({ allowed: false, status: 404, error: 'not_found' });
    expect(await f.service.publish(staff, proposal.id)).toEqual({ status: 404, code: 'not_found' });
    expect(f.repository.proposals.get(proposal.id)?.state).toBe('proposed');
  });

  it('paginates by the same starts_at/id tuple encoded in its opaque cursor', async () => {
    const f = fixture(null);
    f.repository.events.clear();
    for (const [id, startsAt] of [
      ['10000000-0000-4000-8000-000000000031', '2026-09-20T16:00:00.000Z'],
      ['10000000-0000-4000-8000-000000000032', '2026-09-20T16:00:00.000Z'],
      ['10000000-0000-4000-8000-000000000033', '2026-09-21T16:00:00.000Z'],
    ] as const) f.repository.seed({ id, orgId: org, title: id, startsAt: new Date(startsAt), location: 'Hall', capacity: null });
    const first = await f.service.list(alice, { limit: 2 });
    if ('status' in first || !first.meta.next_cursor) throw new Error('expected first page');
    expect(first.items.map(item => item.id)).toEqual(['10000000-0000-4000-8000-000000000031', '10000000-0000-4000-8000-000000000032']);
    expect(first.meta.next_cursor).not.toContain('|');
    const second = await f.service.list(alice, { limit: 2, cursor: first.meta.next_cursor });
    if ('status' in second) throw new Error('expected second page');
    expect(second.items.map(item => item.id)).toEqual(['10000000-0000-4000-8000-000000000033']);
    expect(second.meta.next_cursor).toBeNull();
  });

  it('stores an explicit IANA zone and uses the injected org zone for legacy proposals across DST', async () => {
    const f = fixture();
    const before = zonedLocalDateTimeToIso('2026-03-08T01:30', 'America/New_York');
    const after = zonedLocalDateTimeToIso('2026-03-08T03:30', 'America/New_York');
    expect(before).toBe('2026-03-08T06:30:00.000Z');
    expect(after).toBe('2026-03-08T07:30:00.000Z');
    expect(formatEventDateTime(before, 'America/New_York')).toContain('1:30 AM');
    expect(formatEventDateTime(after, 'America/New_York')).toContain('3:30 AM');
    const legacy = await f.service.propose(alice, { title: 'DST-safe event', starts_at: '2027-03-14T07:30:00.000Z' });
    if ('status' in legacy) throw new Error('expected proposal');
    expect(legacy.time_zone).toBe('America/New_York');
    expect(f.orgTimeZone.forOrg).toHaveBeenCalledWith(org);
  });

  it('rejects time zones that are not valid contract-bounded IANA identifiers', async () => {
    const f = fixture();
    expect(await f.service.propose(alice, { title: 'Invalid zone', starts_at: '2027-03-14T07:30:00.000Z', time_zone: 'Eastern Time' }))
      .toEqual({ status: 422, code: 'invalid_event_proposal' });
    expect(await f.service.propose(alice, { title: 'Oversized zone', starts_at: '2027-03-14T07:30:00.000Z', time_zone: `America/${'A'.repeat(100)}` }))
      .toEqual({ status: 422, code: 'invalid_event_proposal' });
  });

  // what_bug_this_catches: recommendation availability depends on an AI provider or flag service.
  it('ranks natively with AI absent', async () => {
    const f = fixture(null);
    f.repository.seed({ orgId: org, title: 'Accessible craft', startsAt: new Date('2026-09-30T16:00:00.000Z'), location: 'Library', capacity: null, accessibility: ['step-free'] });
    f.repository.setAccessibility(alice, ['step-free']);
    const result = await f.service.recommend(alice);
    if ('status' in result) throw new Error('expected recommendations');
    expect(result.items[0]?.title).toBe('Community lunch');
    expect(result.reasons[result.items[0]!.id]).toContain('step-free');
  });

  // what_bug_this_catches: tenant-scoped misses reveal that a foreign event exists.
  it('uses the same opaque denial for foreign and missing events', async () => {
    const f = fixture();
    const foreign = { ...alice, orgId: otherOrg };
    expect(await f.service.get(foreign, f.event.id)).toEqual(await f.service.get(foreign, '30000000-0000-4000-8000-000000000001'));
    expect(await f.service.rsvp({ ...alice, roles: ['caregiver'] }, f.event.id)).toEqual({ status: 404, code: 'not_found' });
  });
});
