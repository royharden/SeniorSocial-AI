import { createHash, randomUUID } from 'node:crypto';
import { encodeEventCursor } from './cursor.ts';
import type {
  CancelResult, EventIdentity, EventListQuery, EventProposalInput, EventRepository, EventView,
  Page, ProposalResource, ProposalView, PublishInput, RecommendationContext, ReminderIntent, RsvpResult, RsvpView, WaitlistResult,
} from './types.ts';

interface StoredEvent extends EventView { startsAt: Date; published: boolean; proposalId: string | null }
interface StoredRsvp extends RsvpView { orgId: string; userId: string; createdAt: Date }
interface StoredProposal extends ProposalView { orgId: string; proposerId: string; title: string; startsAt: Date; note: string | null }

export interface MemoryEventSeed {
  id?: string; orgId: string; title: string; startsAt: Date; location: string;
  capacity: number | null; accessibility?: string[]; published?: boolean; timeZone?: string;
}

export class MemoryEventRepository implements EventRepository {
  readonly events = new Map<string, StoredEvent>();
  readonly rsvps = new Map<string, StoredRsvp>();
  readonly proposals = new Map<string, StoredProposal>();
  readonly reminderIntents = new Map<string, ReminderIntent>();
  readonly accessibility = new Map<string, string[]>();
  #tail: Promise<void> = Promise.resolve();

  constructor(private readonly defaultTimeZone: string) {}

  seed(input: MemoryEventSeed): EventView {
    const id = input.id ?? randomUUID();
    const event: StoredEvent = { id, org_id: input.orgId, title: input.title, starts_at: input.startsAt.toISOString(), time_zone: input.timeZone ?? this.defaultTimeZone,
      startsAt: new Date(input.startsAt), location: input.location, capacity: input.capacity, rsvp_count: 0,
      accessibility: [...(input.accessibility ?? [])], published: input.published ?? true, proposalId: null };
    this.events.set(id, event);
    return view(event);
  }
  setAccessibility(identity: EventIdentity, values: string[]): void { this.accessibility.set(`${identity.orgId}:${identity.userId}`, [...values]); }
  async #locked<T>(work: () => T | Promise<T>): Promise<T> {
    let release!: () => void;
    const prior = this.#tail;
    this.#tail = new Promise<void>(resolve => { release = resolve; });
    await prior;
    try { return await work(); } finally { release(); }
  }
  list(identity: EventIdentity, input: EventListQuery): Promise<Page<EventView>> {
    const from = input.from ? new Date(`${input.from}T00:00:00.000Z`) : null;
    const to = input.to ? new Date(`${input.to}T23:59:59.999Z`) : null;
    const selected = [...this.events.values()].filter(event => event.org_id === identity.orgId && event.published &&
      (!from || event.startsAt >= from) && (!to || event.startsAt <= to) && (!input.cursor ||
        event.startsAt.toISOString() > input.cursor.startsAt || (event.startsAt.toISOString() === input.cursor.startsAt && event.id > input.cursor.id)))
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.id.localeCompare(b.id));
    const items = selected.slice(0, input.limit).map(view);
    const last = items.at(-1);
    return Promise.resolve({ items, meta: { next_cursor: selected.length > input.limit && last ? encodeEventCursor({ startsAt: last.starts_at, id: last.id }) : null, total_known: true } });
  }
  find(identity: EventIdentity, eventId: string): Promise<EventView | null> {
    const event = this.events.get(eventId);
    return Promise.resolve(event?.org_id === identity.orgId && event.published ? view(event) : null);
  }
  async rsvp(identity: EventIdentity, eventId: string): Promise<RsvpResult> {
    return this.#locked(() => {
      const event = this.events.get(eventId);
      if (!event || !event.published || event.org_id !== identity.orgId) return { kind: 'not_found' };
      const existing = this.#rsvp(identity, eventId);
      if (existing?.state === 'attending') { this.#ensureReminder(existing, event); return { kind: 'attending', rsvp: rsvpView(existing), startsAt: event.startsAt }; }
      const count = this.#attending(identity.orgId, eventId);
      if (event.capacity !== null && count >= event.capacity) return { kind: 'full' };
      const stored: StoredRsvp = existing ? Object.assign(existing, { state: 'attending' as const }) :
        { id: randomUUID(), event_id: eventId, state: 'attending', orgId: identity.orgId, userId: identity.userId, createdAt: new Date() };
      this.rsvps.set(stored.id, stored);
      event.rsvp_count = count + 1;
      this.#ensureReminder(stored, event);
      return { kind: 'attending', rsvp: rsvpView(stored), startsAt: event.startsAt };
    });
  }
  async waitlist(identity: EventIdentity, eventId: string): Promise<WaitlistResult> {
    return this.#locked(() => {
      const event = this.events.get(eventId);
      if (!event || !event.published || event.org_id !== identity.orgId) return { kind: 'not_found' };
      const existing = this.#rsvp(identity, eventId);
      if (existing?.state === 'attending') return { kind: 'attending', rsvp: rsvpView(existing) };
      if (event.capacity === null || this.#attending(identity.orgId, eventId) < event.capacity) return { kind: 'not_full' };
      if (existing && existing.state !== 'waitlisted') existing.createdAt = new Date();
      const stored: StoredRsvp = existing ? Object.assign(existing, { state: 'waitlisted' as const }) :
        { id: randomUUID(), event_id: eventId, state: 'waitlisted', orgId: identity.orgId, userId: identity.userId, createdAt: new Date() };
      this.rsvps.set(stored.id, stored);
      return { kind: 'waitlisted', rsvp: rsvpView(stored) };
    });
  }
  async cancel(identity: EventIdentity, eventId: string): Promise<CancelResult> {
    return this.#locked(() => {
      const event = this.events.get(eventId);
      if (!event || !event.published || event.org_id !== identity.orgId) return { cancelled: false, promoted: null, promotedUserId: null, startsAt: null };
      const current = this.#rsvp(identity, eventId);
      if (!current || current.state === 'cancelled') return { cancelled: false, promoted: null, promotedUserId: null, startsAt: event.startsAt };
      const releasedSeat = current.state === 'attending';
      current.state = 'cancelled';
      let promoted: StoredRsvp | null = null;
      if (releasedSeat) {
        promoted = [...this.rsvps.values()].filter(item => item.orgId === identity.orgId && item.event_id === eventId && item.state === 'waitlisted')
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))[0] ?? null;
        if (promoted) { promoted.state = 'attending'; this.#ensureReminder(promoted, event); }
        else event.rsvp_count--;
      }
      return { cancelled: true, promoted: promoted ? rsvpView(promoted) : null, promotedUserId: promoted?.userId ?? null, startsAt: event.startsAt };
    });
  }
  propose(identity: EventIdentity, input: EventProposalInput): Promise<ProposalView> {
    const proposal: StoredProposal = { id: randomUUID(), orgId: identity.orgId, proposerId: identity.userId, title: input.title,
      startsAt: new Date(input.starts_at), note: input.note ?? null, state: 'proposed', time_zone: input.time_zone ?? this.defaultTimeZone };
    this.proposals.set(proposal.id, proposal);
    return Promise.resolve(proposalView(proposal));
  }
  proposalResource(identity: EventIdentity, proposalId: string): Promise<ProposalResource | null> {
    const proposal = this.proposals.get(proposalId);
    return Promise.resolve(proposal?.orgId === identity.orgId ? { id: proposal.id, orgId: proposal.orgId, residentId: proposal.proposerId, kind: 'event' } : null);
  }
  async publish(identity: EventIdentity, proposalId: string, input: PublishInput): Promise<EventView | null> {
    return this.#locked(() => {
      const proposal = this.proposals.get(proposalId);
      if (!proposal || proposal.orgId !== identity.orgId) return null;
      const existing = [...this.events.values()].find(event => event.org_id === identity.orgId && event.proposalId === proposalId);
      if (existing) return view(existing);
      if (proposal.state !== 'proposed') return null;
      proposal.state = 'published';
      const event = this.seed({ orgId: identity.orgId, title: proposal.title, startsAt: proposal.startsAt,
        location: input.location?.trim() || 'To be announced', capacity: input.capacity ?? null,
        accessibility: [...(input.accessibility ?? [])], published: true, timeZone: proposal.time_zone });
      const stored = this.events.get(event.id);
      if (stored) stored.proposalId = proposalId;
      return event;
    });
  }
  recommendationContext(identity: EventIdentity): Promise<RecommendationContext> {
    return Promise.resolve({ accessibility: [...(this.accessibility.get(`${identity.orgId}:${identity.userId}`) ?? [])] });
  }
  pendingReminderIntents(identity: EventIdentity): Promise<ReminderIntent[]> {
    return Promise.resolve([...this.reminderIntents.values()].filter(intent => intent.orgId === identity.orgId && intent.state === 'pending').map(intent => ({ ...intent, dueAt: new Date(intent.dueAt) })));
  }
  completeReminderIntent(identity: EventIdentity, idempotencyKey: string): Promise<void> {
    const intent = this.reminderIntents.get(idempotencyKey);
    if (intent?.orgId === identity.orgId) intent.state = 'drained';
    return Promise.resolve();
  }
  #rsvp(identity: EventIdentity, eventId: string): StoredRsvp | undefined {
    return [...this.rsvps.values()].find(item => item.orgId === identity.orgId && item.userId === identity.userId && item.event_id === eventId);
  }
  #attending(orgId: string, eventId: string): number {
    return [...this.rsvps.values()].filter(item => item.orgId === orgId && item.event_id === eventId && item.state === 'attending').length;
  }
  #ensureReminder(rsvp: StoredRsvp, event: StoredEvent): void {
    const idempotencyKey = createHash('sha256').update(`${rsvp.orgId}:${rsvp.userId}:${rsvp.id}:event_reminder`).digest('hex');
    if (!this.reminderIntents.has(idempotencyKey)) this.reminderIntents.set(idempotencyKey, { idempotencyKey, eventId: event.id,
      orgId: rsvp.orgId, userId: rsvp.userId, purpose: 'event_reminder', dueAt: new Date(event.startsAt.getTime() - 86_400_000), state: 'pending' });
  }
}

function view(event: StoredEvent): EventView { return { id: event.id, org_id: event.org_id, title: event.title, starts_at: event.starts_at, time_zone: event.time_zone,
  location: event.location, capacity: event.capacity, rsvp_count: event.rsvp_count, accessibility: [...event.accessibility] }; }
function rsvpView(rsvp: StoredRsvp): RsvpView { return { id: rsvp.id, event_id: rsvp.event_id, state: rsvp.state }; }
function proposalView(proposal: StoredProposal): ProposalView { return { id: proposal.id, state: proposal.state, time_zone: proposal.time_zone }; }
