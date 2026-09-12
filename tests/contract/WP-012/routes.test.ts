import { describe, expect, it } from 'vitest';
import { createEvents, MemoryEventRepository, type EventIdentity } from '../../../packages/events/src/index.ts';
import { createListEventsHandler } from '../../../apps/web/app/api/v1/events/route.ts';
import { createRsvpHandlers } from '../../../apps/web/app/api/v1/events/[eventId]/rsvp/route.ts';
import { createProposalHandler } from '../../../apps/web/app/api/v1/event-proposals/route.ts';

const identity: EventIdentity = { orgId: '10000000-0000-4000-8000-000000000001', userId: '10000000-0000-4000-8000-000000000011', roles: ['senior'] };
function dependencies() {
  const repository = new MemoryEventRepository('America/New_York');
  const event = repository.seed({ orgId: identity.orgId, title: 'Lunch', startsAt: new Date('2026-09-20T16:00:00Z'), location: 'Hall', capacity: 1 });
  const service = createEvents({ repository, reminders: { schedule: () => Promise.resolve() }, authorization: { authorize: () => Promise.resolve({ allowed: true }) },
    orgTimeZone: { forOrg: () => Promise.resolve('America/New_York') }, clock: () => new Date('2026-09-10T12:00:00Z') });
  return { event, authorize: () => Promise.resolve(identity), run: async <T>(work: (value: typeof service) => Promise<T>) => work(service) };
}

describe('WP-012 locked HTTP contract', () => {
  it('returns EventPage and Rsvp shapes on the immutable routes', async () => {
    const deps = dependencies();
    const list = await createListEventsHandler(deps)(new Request('http://local/api/v1/events'));
    expect(await list.json()).toMatchObject({ items: [{ id: deps.event.id, org_id: identity.orgId, time_zone: 'America/New_York', rsvp_count: 0 }], meta: { total_known: true } });
    const handlers = createRsvpHandlers(deps);
    const response = await handlers.POST(new Request('http://local', { method: 'POST' }), { params: Promise.resolve({ eventId: deps.event.id }) });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(expect.objectContaining({ event_id: deps.event.id, state: 'attending' }));
  });

  it('accepts only the locked proposal body and returns proposed state', async () => {
    const deps = dependencies();
    const handler = createProposalHandler(deps);
    const response = await handler(new Request('http://local/api/v1/event-proposals', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Game night', starts_at: '2026-09-21T18:00:00Z' }) }));
    expect(response.status).toBe(201);
    const body: unknown = await response.json();
    expect(body).toEqual(expect.objectContaining({ state: 'proposed' }));
    expect(body && typeof body === 'object' && 'id' in body && typeof body.id === 'string').toBe(true);
    expect(body && typeof body === 'object' && 'time_zone' in body && body.time_zone).toBe('America/New_York');
  });
});
