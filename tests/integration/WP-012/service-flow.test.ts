import { describe, expect, it } from 'vitest';
import { createEvents, MemoryEventRepository, type EventIdentity } from '../../../packages/events/src/index.ts';

describe('WP-012 integrated resident flow', () => {
  it('browses, fills, waitlists, cancels and promotes through one service boundary', async () => {
    const orgId = '10000000-0000-4000-8000-000000000001';
    const first: EventIdentity = { orgId, userId: '10000000-0000-4000-8000-000000000011', roles: ['senior'] };
    const second: EventIdentity = { orgId, userId: '10000000-0000-4000-8000-000000000012', roles: ['senior'] };
    const repository = new MemoryEventRepository('America/New_York');
    const event = repository.seed({ orgId, title: 'Walking club', startsAt: new Date('2026-09-20T16:00:00Z'), location: 'Park', capacity: 1 });
    const reminders: string[] = [];
    const service = createEvents({ repository, reminders: { schedule: request => { reminders.push(request.userId); return Promise.resolve(); } },
      authorization: { authorize: () => Promise.resolve({ allowed: true }) }, orgTimeZone: { forOrg: () => Promise.resolve('America/New_York') } });
    const page = await service.list(first);
    if ('status' in page) throw new Error('expected event page');
    expect(page.items[0]?.id).toBe(event.id);
    expect(await service.rsvp(first, event.id)).toMatchObject({ state: 'attending' });
    expect(await service.rsvp(second, event.id)).toMatchObject({ status: 409 });
    expect(await service.waitlist(second, event.id)).toMatchObject({ state: 'waitlisted' });
    expect(await service.cancel(first, event.id)).toEqual({ cancelled: true });
    expect(reminders).toEqual([first.userId, second.userId]);
  });
});
