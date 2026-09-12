import { createHash, randomUUID } from 'node:crypto';
import { withOrg, type DatabaseClient, type TenantTransaction } from '../../db/src/index.ts';
import { defaultPreferences, nextDeliveryAt, parsePreferences, permits } from '../../notify/src/index.ts';
import { encodeEventCursor } from './cursor.ts';
import type {
  CancelResult, EventIdentity, EventProposalInput, EventRepository, EventView, Page, ProposalResource,
  ProposalView, PublishInput, RecommendationContext, ReminderIntent, ReminderRequest, ReminderScheduler,
  RsvpResult, RsvpView, WaitlistResult,
} from './types.ts';

interface EventRow { id: string; org_id: string; title: string; starts_at: Date; time_zone: string; location: string; capacity: number | null; rsvp_count: number; accessibility: string[] }
interface RsvpRow { id: string; event_id: string; user_id: string; state: RsvpView['state'] }
interface ProposalRow { id: string; proposer_id: string; state: ProposalView['state']; title: string; starts_at: Date; time_zone: string }
interface ReminderRow { idempotency_key: string; event_id: string; org_id: string; user_id: string; purpose: 'event_reminder'; due_at: Date; state: 'pending' | 'drained' }
const eventView = (row: EventRow): EventView => ({ id: row.id, org_id: row.org_id, title: row.title, starts_at: row.starts_at.toISOString(), time_zone: row.time_zone,
  location: row.location, capacity: row.capacity, rsvp_count: Number(row.rsvp_count), accessibility: row.accessibility });
const rsvpView = (row: RsvpRow): RsvpView => ({ id: row.id, event_id: row.event_id, state: row.state });

async function scoped<T>(client: DatabaseClient, identity: EventIdentity, work: (sql: TenantTransaction) => Promise<T>): Promise<T> {
  return withOrg(client, identity.orgId, async sql => {
    const roles = await sql<{ unsafe: boolean }[]>`select r.rolsuper or r.rolbypassrls or
      exists(select 1 from pg_class c where c.relname = 'events' and c.relowner = r.oid) as unsafe
      from pg_roles r where r.rolname = current_user`;
    if (roles[0]?.unsafe !== false) throw new Error('Events repository requires non-owner RLS role');
    return work(sql);
  });
}

function reminderKey(identity: EventIdentity, rsvp: RsvpRow): string {
  return createHash('sha256').update(`${identity.orgId}:${rsvp.user_id}:${rsvp.id}:event_reminder`).digest('hex');
}
async function ensureReminder(sql: TenantTransaction, identity: EventIdentity, event: EventRow, rsvp: RsvpRow): Promise<void> {
  const key = reminderKey(identity, rsvp);
  await sql`insert into event_reminder_intents (id, org_id, user_id, event_id, rsvp_id, purpose, idempotency_key, due_at)
    values (${randomUUID()}, ${identity.orgId}, ${rsvp.user_id}, ${event.id}, ${rsvp.id}, 'event_reminder', ${key}, ${new Date(event.starts_at.getTime() - 86_400_000)})
    on conflict (org_id, idempotency_key) do nothing`;
}

/** Serializes capacity and promotion decisions without requiring UPDATE on the
 * immutable event definition. Both UUIDs are already tenant-authenticated by
 * the service/withOrg boundary; a 64-bit transaction lock scopes contention to
 * one event and is released automatically on commit or rollback.
 */
async function lockEvent(sql: TenantTransaction, identity: EventIdentity, eventId: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`${identity.orgId}:${eventId}`}, 0))`;
}

export function createPostgresEventRepository(client: DatabaseClient): EventRepository {
  return {
    async list(identity, input): Promise<Page<EventView>> {
      return scoped(client, identity, async sql => {
        const from = input.from ? new Date(`${input.from}T00:00:00.000Z`) : new Date(0);
        const to = input.to ? new Date(`${input.to}T23:59:59.999Z`) : new Date('9999-12-31T23:59:59.999Z');
        const rows = await sql<EventRow[]>`select e.id, e.org_id, e.title, e.starts_at, e.location, e.capacity, e.accessibility,
          e.time_zone,
          count(r.id) filter (where r.state = 'attending')::int as rsvp_count
          from events e left join event_rsvps r on r.org_id = e.org_id and r.event_id = e.id
          where e.org_id = ${identity.orgId} and e.published_at is not null and e.starts_at between ${from} and ${to}
            and (${input.cursor?.startsAt ?? null}::timestamptz is null or
              (e.starts_at, e.id) > (${input.cursor?.startsAt ?? null}::timestamptz, ${input.cursor?.id ?? null}::uuid))
          group by e.id order by e.starts_at, e.id limit ${input.limit + 1}`;
        const selected = rows.slice(0, input.limit);
        const last = selected.at(-1);
        return { items: selected.map(eventView), meta: { next_cursor: rows.length > input.limit && last ?
          encodeEventCursor({ startsAt: last.starts_at.toISOString(), id: last.id }) : null, total_known: true } };
      });
    },
    async find(identity, eventId): Promise<EventView | null> {
      return scoped(client, identity, async sql => {
        const rows = await sql<EventRow[]>`select e.id, e.org_id, e.title, e.starts_at, e.time_zone, e.location, e.capacity, e.accessibility,
          count(r.id) filter (where r.state = 'attending')::int as rsvp_count
          from events e left join event_rsvps r on r.org_id = e.org_id and r.event_id = e.id
          where e.org_id = ${identity.orgId} and e.id = ${eventId} and e.published_at is not null group by e.id`;
        return rows[0] ? eventView(rows[0]) : null;
      });
    },
    async rsvp(identity, eventId): Promise<RsvpResult> {
      return scoped(client, identity, async sql => {
        await lockEvent(sql, identity, eventId);
        const events = await sql<EventRow[]>`select e.*, 0::int as rsvp_count from events e
          where org_id = ${identity.orgId} and id = ${eventId} and published_at is not null`;
        const event = events[0];
        if (!event) return { kind: 'not_found' };
        const existing = (await sql<RsvpRow[]>`select id, event_id, user_id, state from event_rsvps
          where org_id = ${identity.orgId} and event_id = ${eventId} and user_id = ${identity.userId} for update`)[0];
        if (existing?.state === 'attending') { await ensureReminder(sql, identity, event, existing); return { kind: 'attending', rsvp: rsvpView(existing), startsAt: event.starts_at }; }
        const counts = await sql<{ count: number }[]>`select count(*)::int as count from event_rsvps
          where org_id = ${identity.orgId} and event_id = ${eventId} and state = 'attending'`;
        if (event.capacity !== null && Number(counts[0]?.count ?? 0) >= event.capacity) return { kind: 'full' };
        const id = existing?.id ?? randomUUID();
        const rows = await sql<RsvpRow[]>`insert into event_rsvps (id, org_id, event_id, user_id, state)
          values (${id}, ${identity.orgId}, ${eventId}, ${identity.userId}, 'attending')
          on conflict (org_id, event_id, user_id) do update set state = 'attending', updated_at = now()
          returning id, event_id, user_id, state`;
        await ensureReminder(sql, identity, event, rows[0]!);
        return { kind: 'attending', rsvp: rsvpView(rows[0]!), startsAt: event.starts_at };
      });
    },
    async waitlist(identity, eventId): Promise<WaitlistResult> {
      return scoped(client, identity, async sql => {
        await lockEvent(sql, identity, eventId);
        const events = await sql<EventRow[]>`select e.*, 0::int as rsvp_count from events e
          where org_id = ${identity.orgId} and id = ${eventId} and published_at is not null`;
        const event = events[0];
        if (!event) return { kind: 'not_found' };
        const existing = (await sql<RsvpRow[]>`select id, event_id, user_id, state from event_rsvps
          where org_id = ${identity.orgId} and event_id = ${eventId} and user_id = ${identity.userId} for update`)[0];
        if (existing?.state === 'attending') return { kind: 'attending', rsvp: rsvpView(existing) };
        const count = Number((await sql<{ count: number }[]>`select count(*)::int as count from event_rsvps
          where org_id = ${identity.orgId} and event_id = ${eventId} and state = 'attending'`)[0]?.count ?? 0);
        if (event.capacity === null || count < event.capacity) return { kind: 'not_full' };
        const id = existing?.id ?? randomUUID();
        const rows = await sql<RsvpRow[]>`insert into event_rsvps (id, org_id, event_id, user_id, state, waitlisted_at)
          values (${id}, ${identity.orgId}, ${eventId}, ${identity.userId}, 'waitlisted', now())
          on conflict (org_id, event_id, user_id) do update set state = 'waitlisted',
            waitlisted_at = case when event_rsvps.state = 'waitlisted' then event_rsvps.waitlisted_at else now() end, updated_at = now()
          returning id, event_id, user_id, state`;
        return { kind: 'waitlisted', rsvp: rsvpView(rows[0]!) };
      });
    },
    async cancel(identity, eventId): Promise<CancelResult> {
      return scoped(client, identity, async sql => {
        await lockEvent(sql, identity, eventId);
        const event = (await sql<EventRow[]>`select e.*, 0::int as rsvp_count from events e
          where org_id = ${identity.orgId} and id = ${eventId} and published_at is not null`)[0];
        if (!event) return { cancelled: false, promoted: null, promotedUserId: null, startsAt: null };
        const current = (await sql<RsvpRow[]>`select id, event_id, user_id, state from event_rsvps
          where org_id = ${identity.orgId} and event_id = ${eventId} and user_id = ${identity.userId} for update`)[0];
        if (!current || current.state === 'cancelled') return { cancelled: false, promoted: null, promotedUserId: null, startsAt: event.starts_at };
        const released = current.state === 'attending';
        await sql`update event_rsvps set state = 'cancelled', updated_at = now()
          where org_id = ${identity.orgId} and id = ${current.id}`;
        let promoted: RsvpRow | undefined;
        if (released) {
          promoted = (await sql<RsvpRow[]>`select id, event_id, user_id, state from event_rsvps
            where org_id = ${identity.orgId} and event_id = ${eventId} and state = 'waitlisted'
            order by waitlisted_at, id limit 1 for update`)[0];
          if (promoted) {
            await sql`update event_rsvps set state = 'attending', updated_at = now()
              where org_id = ${identity.orgId} and id = ${promoted.id} and state = 'waitlisted'`;
            promoted.state = 'attending';
            await ensureReminder(sql, identity, event, promoted);
          }
        }
        return { cancelled: true, promoted: promoted ? rsvpView(promoted) : null,
          promotedUserId: promoted?.user_id ?? null, startsAt: event.starts_at };
      });
    },
    async propose(identity, input: EventProposalInput): Promise<ProposalView> {
      return scoped(client, identity, async sql => {
        const rows = await sql<ProposalRow[]>`insert into event_proposals (id, org_id, proposer_id, title, starts_at, time_zone, note)
          values (${randomUUID()}, ${identity.orgId}, ${identity.userId}, ${input.title}, ${new Date(input.starts_at)}, ${input.time_zone!}, ${input.note ?? null})
          returning id, proposer_id, state, title, starts_at, time_zone`;
        return { id: rows[0]!.id, state: rows[0]!.state, time_zone: rows[0]!.time_zone };
      });
    },
    async proposalResource(identity, proposalId): Promise<ProposalResource | null> {
      return scoped(client, identity, async sql => {
        const row = (await sql<{ id: string; org_id: string; proposer_id: string }[]>`select id, org_id, proposer_id from event_proposals
          where org_id = ${identity.orgId} and id = ${proposalId}`)[0];
        return row ? { id: row.id, orgId: row.org_id, residentId: row.proposer_id, kind: 'event' } : null;
      });
    },
    async publish(identity, proposalId, input: PublishInput): Promise<EventView | null> {
      return scoped(client, identity, async sql => {
        const proposal = (await sql<ProposalRow[]>`select id, proposer_id, state, title, starts_at, time_zone from event_proposals
          where org_id = ${identity.orgId} and id = ${proposalId} for update`)[0];
        if (!proposal) return null;
        const existing = (await sql<EventRow[]>`select e.*, 0::int as rsvp_count from events e
          where org_id = ${identity.orgId} and proposal_id = ${proposalId}`)[0];
        if (existing) return eventView(existing);
        if (proposal.state !== 'proposed') return null;
        const rows = await sql<EventRow[]>`insert into events
          (id, org_id, proposal_id, title, starts_at, time_zone, location, capacity, accessibility, published_at, created_by)
          values (${randomUUID()}, ${identity.orgId}, ${proposalId}, ${proposal.title}, ${proposal.starts_at}, ${proposal.time_zone},
            ${input.location?.trim() || 'To be announced'}, ${input.capacity ?? null}, ${[...(input.accessibility ?? [])]}, now(), ${identity.userId})
          returning *, 0::int as rsvp_count`;
        await sql`update event_proposals set state = 'published', reviewed_by = ${identity.userId}, reviewed_at = now()
          where org_id = ${identity.orgId} and id = ${proposalId}`;
        return eventView(rows[0]!);
      });
    },
    async recommendationContext(identity): Promise<RecommendationContext> {
      return scoped(client, identity, async sql => {
        const rows = await sql<{ accessibility_conditions: string[] }[]>`select accessibility_conditions from profiles
          where org_id = ${identity.orgId} and user_id = ${identity.userId}`;
        return { accessibility: rows[0]?.accessibility_conditions ?? [] };
      });
    },
    async pendingReminderIntents(identity): Promise<ReminderIntent[]> {
      return scoped(client, identity, async sql => (await sql<ReminderRow[]>`select idempotency_key, event_id, org_id, user_id, purpose, due_at, state
        from event_reminder_intents where org_id = ${identity.orgId} and state = 'pending' order by due_at, id`).map(row => ({
          idempotencyKey: row.idempotency_key, eventId: row.event_id, orgId: row.org_id, userId: row.user_id,
          purpose: row.purpose, dueAt: row.due_at, state: row.state,
        })));
    },
    async completeReminderIntent(identity, idempotencyKey): Promise<void> {
      await scoped(client, identity, sql => sql`update event_reminder_intents set state = 'drained', drained_at = now()
        where org_id = ${identity.orgId} and idempotency_key = ${idempotencyKey} and state = 'pending'`.then(() => undefined));
    },
  };
}

/** Drains into WP-009's shared durable outbox. WP-009 recovery owns queue
 * re-enqueue after process/bridge failure; this package owns no delivery queue.
 */
export function createPostgresWp009ReminderScheduler(client: DatabaseClient): ReminderScheduler {
  return {
    async schedule(request: ReminderRequest): Promise<void> {
      const identity: EventIdentity = { orgId: request.orgId, userId: request.userId, roles: ['senior'] };
      await scoped(client, identity, async sql => {
        const prefRows = await sql<{ preferences: unknown }[]>`select preferences from notification_preferences
          where org_id = ${request.orgId} and user_id = ${request.userId}`;
        const preferences = prefRows[0] ? parsePreferences(prefRows[0].preferences) : defaultPreferences();
        for (const channel of ['email', 'sms', 'voice'] as const) {
          if (!permits(preferences, 'event_reminder', channel)) continue;
          const idempotencyKey = createHash('sha256').update(JSON.stringify([request.orgId, request.userId, channel, request.idempotencyKey])).digest('hex');
          const payload = { org_id: request.orgId, user_id: request.userId, purpose: 'event_reminder' as const,
            template: 'event.reminder', locale: preferences.locale, params: { event_id: request.eventId }, idempotency_key: idempotencyKey };
          await sql`insert into notification_outbox
            (id, org_id, user_id, actor_id, channel, idempotency_key, payload, state, due_at, attempts, synthetic)
            values (${randomUUID()}, ${request.orgId}, ${request.userId}, ${request.userId}, ${channel}, ${idempotencyKey},
              ${JSON.stringify(payload)}::text::jsonb, 'pending', ${nextDeliveryAt(request.dueAt, preferences, 'event_reminder')}, 0, true)
            on conflict (org_id, user_id, channel, idempotency_key) do nothing`;
        }
      });
    },
  };
}
