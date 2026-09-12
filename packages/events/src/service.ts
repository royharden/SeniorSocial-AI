import { decodeEventCursor } from './cursor.ts';
import { validTimeZone } from './timezone.ts';
import type {
  EventAuthorization, EventIdentity, EventListInput, EventProposalInput, EventRepository, EventReranker,
  EventView, OrgTimeZone, Page, PublishInput, Recommendation, ReminderScheduler,
} from './types.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const date = /^\d{4}-\d{2}-\d{2}$/u;
const allowedRoles = new Set(['senior', 'caregiver', 'staff', 'admin', 'partner', 'support']);
const opaque = { status: 404, code: 'not_found' } as const;

function validIdentity(identity: EventIdentity): boolean {
  return uuid.test(identity.orgId) && uuid.test(identity.userId) && identity.roles.length > 0 && identity.roles.every(role => allowedRoles.has(role));
}
export function createEvents(dependencies: {
  repository: EventRepository;
  reminders: ReminderScheduler;
  authorization: EventAuthorization;
  orgTimeZone: OrgTimeZone;
  clock?: () => Date;
  reranker?: EventReranker;
}) {
  const { repository, reminders, authorization, orgTimeZone, reranker } = dependencies;
  const clock = dependencies.clock ?? (() => new Date());
  const authorize = (identity: EventIdentity): boolean => validIdentity(identity);
  const resident = (identity: EventIdentity): boolean => authorize(identity) && identity.roles.includes('senior');
  async function recoverReminders(identity: EventIdentity): Promise<void> {
    if (!authorize(identity)) throw new Error('Invalid event reminder recovery identity');
    for (const intent of await repository.pendingReminderIntents(identity)) {
      await reminders.schedule(intent);
      await repository.completeReminderIntent(identity, intent.idempotencyKey);
    }
  }
  async function list(identity: EventIdentity, input: Partial<EventListInput> = {}): Promise<Page<EventView> | typeof opaque> {
    if (!authorize(identity)) return opaque;
    const limit = input.limit ?? 25;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (input.from !== undefined && !date.test(input.from)) ||
        (input.to !== undefined && !date.test(input.to))) return opaque;
    const cursor = decodeEventCursor(input.cursor);
    if (input.cursor !== undefined && cursor === null) return opaque;
    return repository.list(identity, { from: input.from ?? clock().toISOString().slice(0, 10),
      ...(input.to === undefined ? {} : { to: input.to }), cursor, limit });
  }
  async function get(identity: EventIdentity, eventId: string): Promise<EventView | typeof opaque> {
    if (!authorize(identity) || !uuid.test(eventId)) return opaque;
    return await repository.find(identity, eventId) ?? opaque;
  }
  async function rsvp(identity: EventIdentity, eventId: string) {
    if (!resident(identity) || !uuid.test(eventId)) return opaque;
    const result = await repository.rsvp(identity, eventId);
    if (result.kind === 'not_found') return opaque;
    if (result.kind === 'full') return { status: 409, code: 'event_at_capacity' } as const;
    await recoverReminders(identity);
    return result.rsvp;
  }
  async function waitlist(identity: EventIdentity, eventId: string) {
    if (!resident(identity) || !uuid.test(eventId)) return opaque;
    const result = await repository.waitlist(identity, eventId);
    if (result.kind === 'not_found') return opaque;
    if (result.kind === 'not_full') return { status: 409, code: 'event_has_capacity' } as const;
    return result.rsvp;
  }
  async function cancel(identity: EventIdentity, eventId: string) {
    if (!resident(identity) || !uuid.test(eventId)) return opaque;
    const result = await repository.cancel(identity, eventId);
    if (result.startsAt === null) return opaque;
    await recoverReminders(identity);
    return { cancelled: result.cancelled } as const;
  }
  async function propose(identity: EventIdentity, input: EventProposalInput) {
    if (!resident(identity) || typeof input !== 'object' || input === null) return opaque;
    const keys = Object.keys(input);
    const startsAt = new Date(input.starts_at);
    if (keys.some(key => !['title', 'starts_at', 'time_zone', 'note'].includes(key)) || typeof input.title !== 'string' || input.title.trim().length < 1 ||
        input.title.length > 200 || typeof input.starts_at !== 'string' || !Number.isFinite(startsAt.getTime()) || startsAt <= clock() ||
        (input.note !== undefined && (typeof input.note !== 'string' || input.note.length > 4000))) return { status: 422, code: 'invalid_event_proposal' } as const;
    const timeZone = input.time_zone ?? await orgTimeZone.forOrg(identity.orgId);
    if (typeof timeZone !== 'string' || !validTimeZone(timeZone)) return { status: 422, code: 'invalid_event_proposal' } as const;
    return repository.propose(identity, { title: input.title.trim(), starts_at: startsAt.toISOString(), time_zone: timeZone,
      ...(input.note === undefined ? {} : { note: input.note }) });
  }
  async function publish(identity: EventIdentity, proposalId: string, input: PublishInput = {}) {
    if (!authorize(identity) || !uuid.test(proposalId) || (input.capacity !== undefined && input.capacity !== null &&
      (!Number.isSafeInteger(input.capacity) || input.capacity < 1))) return opaque;
    const resource = await repository.proposalResource(identity, proposalId);
    if (!resource) return opaque;
    const actor = { id: identity.userId, orgId: identity.orgId, roles: identity.roles };
    const decision = await authorization.authorize({ actor, decisionActor: actor, orgId: identity.orgId, resource, action: 'manage' });
    if (!decision.allowed) return opaque;
    return await repository.publish(identity, proposalId, input) ?? opaque;
  }
  async function recommend(identity: EventIdentity, input: Partial<EventListInput> = {}) {
    const page = await list(identity, input);
    if ('status' in page) return page;
    const context = await repository.recommendationContext(identity);
    let recommendations: readonly Recommendation[] = page.items.map(event => {
      const matches = event.accessibility.filter(item => context.accessibility.includes(item));
      return { event, reason: matches.length > 0 ? `Matches ${matches.join(', ')}` : 'Soonest upcoming event' };
    }).sort((a, b) => {
      const aMatches = a.event.accessibility.filter(item => context.accessibility.includes(item)).length;
      const bMatches = b.event.accessibility.filter(item => context.accessibility.includes(item)).length;
      return bMatches - aMatches || a.event.starts_at.localeCompare(b.event.starts_at) || a.event.id.localeCompare(b.event.id);
    });
    // Native ordering is always complete. An unavailable/disabled reranker is not an error path.
    if (reranker && await reranker.enabled(identity.orgId)) recommendations = await reranker.rerank(identity, recommendations);
    return { items: recommendations.map(item => item.event), meta: page.meta, reasons: Object.fromEntries(recommendations.map(item => [item.event.id, item.reason])) };
  }
  return { list, get, rsvp, waitlist, cancel, propose, publish, recommend, recoverReminders };
}

export type EventsService = ReturnType<typeof createEvents>;
