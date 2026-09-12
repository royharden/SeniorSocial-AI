import { schemas, type PrintableSchedule, type Notification } from '@seniorsocial/contracts';
import { withOrg, type DatabaseClient, type TenantTransaction } from '@seniorsocial/db';
import { defaultPreferences, nextDeliveryAt, parsePreferences, purposes } from './preferences.ts';
import { createHash } from 'node:crypto';
import type { Identity } from './types.ts';
import type { ScheduleSourceMetadata } from './schedule.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sourceVersion = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/;
const sourceKey = /^[a-z][a-z0-9-]{0,39}$/;
const sourceFields = ['as_of','item_count','key','source_version','status'];
function validSourceInstant(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value) || value.startsWith('0000-')) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0,19) === value.slice(0,19);
}
function scheduleSources(value: unknown): ScheduleSourceMetadata[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 8 || Buffer.byteLength(JSON.stringify(value),'utf8') > 8192) throw new Error('Invalid schedule sources');
  const keys = new Set<string>();
  const values: unknown[] = value;
  const result = values.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).sort().join(',') !== sourceFields.join(',')) throw new Error('Invalid schedule source');
    const source = item as Partial<ScheduleSourceMetadata>;
    if (typeof source.key !== 'string' || !sourceKey.test(source.key) || keys.has(source.key) ||
      !['available','not_registered','unavailable'].includes(source.status ?? '') ||
      !Number.isInteger(source.item_count) || source.item_count! < 0 || source.item_count! > 9999) throw new Error('Invalid schedule source');
    keys.add(source.key);
    if (source.status === 'available') {
      if (typeof source.source_version !== 'string' || !sourceVersion.test(source.source_version) || typeof source.as_of !== 'string' ||
        !validSourceInstant(source.as_of)) throw new Error('Invalid schedule source');
    } else if (source.source_version !== null || source.as_of !== null || source.item_count !== 0) throw new Error('Invalid schedule source');
    return structuredClone(source as ScheduleSourceMetadata);
  });
  return result;
}
export function createResidentRepository(client: DatabaseClient) {
  async function scoped<T>(identity: Identity, work: (sql: TenantTransaction) => Promise<T>) {
    if (!uuid.test(identity.orgId) || !uuid.test(identity.userId)) throw new Error('Unavailable');
    return withOrg(client, identity.orgId, async sql => {
      const roles = await sql<{unsafe: boolean}[]>`select r.rolsuper or r.rolbypassrls or exists(select 1 from pg_class c where c.relname = 'notification_inbox' and c.relowner = r.oid) as unsafe from pg_roles r where r.rolname = current_user`;
      if (roles[0]?.unsafe !== false) throw new Error('Constrained role required');
      await sql`select set_config('app.current_user_id', ${identity.userId}, true)`;
      const active = await sql<{id: string}[]>`select id from users where org_id = ${identity.orgId} and id = ${identity.userId} and account_state = 'active'`;
      if (active.length !== 1) throw new Error('Unavailable');
      return work(sql);
    });
  }
  return {
    async list(identity: Identity, cursor?: string, locale?: 'en' | 'es', recheck: () => Promise<void> = () => Promise.resolve()) {
      const separator = cursor?.lastIndexOf('|') ?? -1;
      const at = cursor?.slice(0, separator);
      const id = cursor?.slice(separator + 1);
      if (cursor && (separator < 1 || !at || !id || !uuid.test(id) || !Number.isFinite(Date.parse(at)))) throw new Error('Invalid cursor');
      return scoped(identity, async sql => {
        await recheck();
        const settings = (await sql<{preferences:unknown;now:Date}[]>`select p.preferences,statement_timestamp() as now
          from users u left join notification_preferences p on p.org_id=u.org_id and p.user_id=u.id
          where u.org_id=${identity.orgId} and u.id=${identity.userId}`)[0];
        if (!settings) throw new Error('Unavailable');
        const preferences = settings.preferences === null ? defaultPreferences() : parsePreferences(settings.preferences);
        const selectedLocale = locale ?? preferences.locale;
        const eventIdToken = '{event_id}';
        const notice = eventReminderNotice(eventIdToken, selectedLocale);
        // In-app notices are independent of outbound contact choices. Reconcile
        // directly from WP-012's durable RSVP intent so a web-only process can
        // expose the notice without pretending that email/SMS/voice was sent.
        // Current event, RSVP and account authority are checked in the same
        // transaction; the stable source key makes HTTP and worker recovery safe.
        if (nextDeliveryAt(settings.now, preferences, 'event_reminder') <= settings.now) {
          await sql`insert into notification_inbox (org_id,user_id,source_key,purpose,title,body)
            select i.org_id,i.user_id,'event-reminder:' || i.event_id,'event_reminder',${notice.title},
              replace(${notice.body},${eventIdToken},i.event_id::text)
            from event_reminder_intents i
            join event_rsvps r on r.org_id=i.org_id and r.id=i.rsvp_id and r.event_id=i.event_id and r.user_id=i.user_id
            join events e on e.org_id=i.org_id and e.id=i.event_id
            join users u on u.org_id=i.org_id and u.id=i.user_id
            where i.org_id=${identity.orgId} and i.user_id=${identity.userId} and i.purpose='event_reminder'
              and i.due_at <= ${settings.now} and r.state='attending'
              and e.published_at is not null and e.starts_at > statement_timestamp() and u.account_state='active'
              and not exists (select 1 from notification_inbox n where n.org_id=i.org_id
                and n.user_id=i.user_id and n.source_key='event-reminder:' || i.event_id)
            order by i.event_id limit 100
            for share of r,u
            on conflict (org_id,user_id,source_key) do nothing`;
        }
        await recheck();
        const rows = await sql<(Notification & {created_at: string})[]>`select id, purpose, title, body, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at, to_char(read_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as read_at
          from notification_inbox where org_id = ${identity.orgId} and user_id = ${identity.userId}
          and (${at ?? null}::text::timestamptz is null or (created_at,id) < (${at ?? null}::text::timestamptz,${id ?? null}::uuid))
          order by created_at desc, id desc limit 101`;
        const page = rows.slice(0,100);
        const last = page.at(-1);
        return schemas.NotificationPage.parse({ items: page.map(({created_at: _created, ...item}) => item), meta: { next_cursor: rows.length > 100 && last ? `${last.created_at}|${last.id!}` : null, total_known: true } });
      });
    },
    async markRead(identity: Identity, id: string) {
      if (!uuid.test(id)) return false;
      return scoped(identity, async sql => {
        await sql`update notification_inbox set read_at = statement_timestamp() where org_id = ${identity.orgId} and user_id = ${identity.userId} and id = ${id} and read_at is null`;
        const rows = await sql<{id: string}[]>`select id from notification_inbox where org_id = ${identity.orgId} and user_id = ${identity.userId} and id = ${id}`;
        return rows.length === 1;
      });
    },
    /** Trusted server producer port; never accept Identity from resident JSON. */
    async publish(identity: Identity, sourceKey: string, input: {purpose: string; title: string; body: string}) {
      if (!/^[A-Za-z0-9:_-]{1,160}$/.test(sourceKey) || !purposes.includes(input.purpose as typeof purposes[number]) || !input.title || input.title.length > 200 || input.body.length > 4000) throw new Error('Invalid notice');
      return scoped(identity, async sql => {
        if (input.purpose === 'event_reminder' && sourceKey.startsWith('event-reminder:')) {
          const eventId = sourceKey.slice('event-reminder:'.length);
          if (!uuid.test(eventId)) throw new Error('Invalid notice');
          // The worker's earlier authorization check cannot protect this later
          // transaction. Hold the current RSVP/account rows through publication,
          // also serializing with a cancellation already in progress.
          const eligible = await sql<{id:string}[]>`select r.id from event_rsvps r
            join events e on e.org_id=r.org_id and e.id=r.event_id
            join users u on u.org_id=r.org_id and u.id=r.user_id
            where r.org_id=${identity.orgId} and r.user_id=${identity.userId} and r.event_id=${eventId}
              and r.state='attending' and e.published_at is not null
              and e.starts_at > statement_timestamp() and u.account_state='active'
            for share of r,u`;
          if (eligible.length !== 1) return;
        }
        await sql`insert into notification_inbox (org_id,user_id,source_key,purpose,title,body) values (${identity.orgId},${identity.userId},${sourceKey},${input.purpose},${input.title},${input.body}) on conflict (org_id,user_id,source_key) do nothing`;
        const same = await sql<{id: string}[]>`select id from notification_inbox where org_id = ${identity.orgId} and user_id = ${identity.userId} and source_key = ${sourceKey} and purpose = ${input.purpose} and title = ${input.title} and body = ${input.body}`;
        if (same.length === 1) return;
        // The authenticated HTTP reconciler and a confirmed outbound worker can
        // race with different locale snapshots. One logical event source must
        // remain one card; whichever authorized path committed first wins.
        if (input.purpose === 'event_reminder' && sourceKey.startsWith('event-reminder:')) {
          const existing = await sql<{id: string}[]>`select id from notification_inbox where org_id=${identity.orgId}
            and user_id=${identity.userId} and source_key=${sourceKey} and purpose='event_reminder'`;
          if (existing.length === 1) return;
        }
        throw new Error('Notification source conflict');
      });
    },
    /** Only a trusted authenticated producer supplies this recheck; queue data
     * cannot manufacture producer evidence. Requests are immutable and reusable. */
    async requestPrint(identity: Identity, weekOf: string, key: string, recheck: () => Promise<void>) {
      return scoped(identity, async sql => {
        await recheck();
        await sql`insert into print_requests(org_id,user_id,week_of,idempotency_key)
          values(${identity.orgId},${identity.userId},${weekOf}::date,${key}) on conflict do nothing`;
        const rows = await sql`select idempotency_key from print_requests where org_id=${identity.orgId} and user_id=${identity.userId} and week_of=${weekOf}::date and idempotency_key=${key}`;
        if (rows.length !== 1) throw new Error('Unavailable');
      });
    },
    /** The API and queue share this one atomic source-read/materialization boundary.
     * Explicit idempotency keys retain their first result even if the source changes.
     * Automatic keys bind a week to an immutable source version. */
    async renderPrint(identity: Identity, weekOf: string, key: string | undefined, readSource: () => Promise<PrintableSchedule>, recheck: () => Promise<void>, requireRequest = false) {
      return scoped(identity, async sql => {
        await sql`select pg_advisory_xact_lock(hashtextextended(${`${identity.orgId}:${identity.userId}:print`},0))`;
        const authorized = async () => {
          await recheck();
          const active = await sql<{id:string}[]>`select id from users where org_id=${identity.orgId} and id=${identity.userId} and account_state='active'`;
          if (active.length !== 1) throw new Error('Unavailable');
        };
        const existing = async (idempotencyKey: string): Promise<PrintableSchedule | null> => {
          const rows = await sql<{week_of:string;as_of:Date;source_version:string;items:PrintableSchedule['items'];sources:unknown}[]>`select week_of::text,as_of,source_version,items,sources from print_jobs
            where org_id=${identity.orgId} and user_id=${identity.userId} and idempotency_key=${idempotencyKey}`;
          const row = rows[0];
          if (!row) return null;
          if (row.week_of !== weekOf) throw new Error('Unavailable');
          const sources = row.sources === null ? undefined : scheduleSources(row.sources);
          return schemas.PrintableSchedule.parse({as_of:row.as_of.toISOString(),source_version:row.source_version,items:row.items,
            ...(sources === undefined ? {} : {sources})});
        };
        await authorized();
        if (requireRequest) {
          const requests = await sql`select idempotency_key from print_requests where org_id=${identity.orgId} and user_id=${identity.userId} and week_of=${weekOf}::date and idempotency_key=${key!}`;
          if (requests.length !== 1) throw new Error('Unavailable');
        }
        if (key) {
          const prior = await existing(key);
          if (prior) { await authorized(); return prior; }
        }
        const snapshot = schemas.PrintableSchedule.parse(await readSource());
        const sources = scheduleSources(snapshot.sources);
        if (sources !== undefined) snapshot.sources = sources;
        if (!snapshot.source_version.trim() || snapshot.source_version.length > 200 || Date.parse(snapshot.as_of) > Date.now() || Buffer.byteLength(JSON.stringify(snapshot.items),'utf8') > 100_000) throw new Error('Invalid snapshot');
        snapshot.as_of = new Date(snapshot.as_of).toISOString();
        const sourcesJson = sources === undefined ? null : JSON.stringify(sources);
        const idempotencyKey = key ?? createHash('sha256').update(JSON.stringify([identity.orgId,identity.userId,weekOf,snapshot.source_version])).digest('hex');
        if (!key) {
          const prior = await existing(idempotencyKey);
          if (prior) {
            const same = await sql<{id:string}[]>`select id from print_jobs where org_id=${identity.orgId} and user_id=${identity.userId} and idempotency_key=${idempotencyKey}
              and as_of=${snapshot.as_of}::text::timestamptz and items=${JSON.stringify(snapshot.items)}::text::jsonb
              and sources is not distinct from ${sourcesJson}::text::jsonb`;
            if (same.length !== 1) throw new Error('Snapshot version conflict');
            await authorized(); return prior;
          }
        }
        await authorized();
        await sql`insert into print_jobs(org_id,user_id,week_of,idempotency_key,as_of,source_version,items,sources)
          values(${identity.orgId},${identity.userId},${weekOf}::date,${idempotencyKey},${snapshot.as_of}::text::timestamptz,${snapshot.source_version},${JSON.stringify(snapshot.items)}::text::jsonb,${sourcesJson}::text::jsonb)`;
        return snapshot;
      });
    },
  };
}

export function eventReminderNotice(eventId: string, locale: 'en' | 'es') {
  return locale === 'es'
    ? { title: 'Recordatorio de evento', body: `Tiene un evento próximo. Revise los detalles actuales antes de asistir. Evento: ${eventId}. Borrador automático, todavía no revisado por una persona.` }
    : { title: 'Event reminder', body: `You have an upcoming event. Review the current details before attending. Event: ${eventId}.` };
}
