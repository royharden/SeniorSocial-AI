import { createHash } from 'node:crypto';
import { schemas, type PrintableSchedule } from '@seniorsocial/contracts';
import type { DatabaseClient } from '@seniorsocial/db';
import { withOrg } from '@seniorsocial/db';
import type { Identity } from './types.ts';
import { createResidentRepository } from './resident.ts';

export interface PrintPayload { idempotency_key: string; org_id: string; user_id: string; week_of: string }
/** A source owns its freshness and version. Future event/ride producers compose
 * here, never by treating previously rendered print_jobs as a live source. */
export interface ScheduleSource { read(identity: Identity, weekOf: string): Promise<PrintableSchedule> }
export const publicScheduleSourceKeys = ['events','rides','assistance'] as const;
export type PublicScheduleSourceKey = typeof publicScheduleSourceKeys[number];
export interface ScheduleSourceRegistration {
  key: string;
  source: ScheduleSource;
  /** When present, only errors classified as an expected source outage are
   * isolated. Other errors propagate so programming and authorization faults
   * cannot be misreported as ordinary source unavailability. */
  isUnavailableError?: (error: unknown) => boolean;
}
export interface ScheduleSourceMetadata {
  key: string;
  status: 'available' | 'not_registered' | 'unavailable';
  source_version: string | null;
  as_of: string | null;
  item_count: number;
}
export type RegisteredSchedule = PrintableSchedule & { sources: ScheduleSourceMetadata[] };
/** Producer helper: pg-boss singleton keys are queue-global, so namespace keys
 * before publication. The bridge never rewrites the canonical payload key. */
export function printIdempotencyKey(identity: Identity, weekOf: string, requestKey: string): string {
  return createHash('sha256').update(JSON.stringify([identity.orgId,identity.userId,weekOf,requestKey])).digest('hex');
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function validWeek(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0,10) === value;
}
export function validPrintPayload(value: unknown): value is PrintPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const p = value as Partial<PrintPayload>;
  return Object.keys(p).sort().join(',') === 'idempotency_key,org_id,user_id,week_of'
    && typeof p.org_id === 'string' && uuid.test(p.org_id) && typeof p.user_id === 'string' && uuid.test(p.user_id)
    && typeof p.idempotency_key === 'string' && /^[A-Za-z0-9:_-]{1,160}$/.test(p.idempotency_key) && validWeek(p.week_of);
}
export function currentWeek(now = new Date()): string {
  const day = new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()));
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay()+6)%7));
  return day.toISOString().slice(0,10);
}
/** The currently connected source set is empty. This is an observed source state,
 * not a claim that the resident has no plans. Minute resolution makes repeated
 * reads of this unchanged state a stable immutable source observation. */
export function createCurrentScheduleSource(clock: () => Date = () => new Date()): ScheduleSource {
  return { read: (_identity,weekOf) => {
    const asOf = new Date(Math.floor(clock().getTime()/60_000)*60_000).toISOString();
    return Promise.resolve({as_of:asOf,source_version:`schedule:no-connected-sources:v1:${weekOf}:${asOf}`,items:[]});
  } };
}

/** Composes only explicit adapters. Expected-but-absent and failed adapters stay
 * visible as source metadata; neither state is represented as an empty plan. */
export function createRegisteredScheduleSource(registrations: readonly ScheduleSourceRegistration[],
  clock: () => Date = () => new Date(), expected: readonly string[] = publicScheduleSourceKeys): ScheduleSource {
  const validKey = /^[a-z][a-z0-9-]{0,39}$/;
  if ([...expected,...registrations.map(item => item.key)].some(key => !validKey.test(key))) throw new Error('Invalid schedule source key');
  const registered = new Map<string,ScheduleSourceRegistration>();
  for (const entry of registrations) {
    if (registered.has(entry.key)) throw new Error('Duplicate schedule source');
    registered.set(entry.key,entry);
  }
  const keys = [...new Set([...expected,...registered.keys()])];
  return { async read(identity,weekOf) {
    if (!uuid.test(identity.orgId) || !uuid.test(identity.userId) || !validWeek(weekOf)) throw new Error('Unavailable');
    const sources: ScheduleSourceMetadata[] = [];
    const items: PrintableSchedule['items'] = [];
    for (const key of keys) {
      const registration = registered.get(key);
      if (!registration) {
        sources.push({key,status:'not_registered',source_version:null,as_of:null,item_count:0});
        continue;
      }
      try {
        const snapshot = schemas.PrintableSchedule.parse(await registration.source.read(identity,weekOf));
        const asOf = new Date(snapshot.as_of).toISOString();
        if (!snapshot.source_version.trim() || snapshot.source_version.length > 200 || Date.parse(asOf) > clock().getTime()) throw new Error('Invalid source snapshot');
        sources.push({key,status:'available',source_version:snapshot.source_version,as_of:asOf,item_count:snapshot.items.length});
        for (const item of snapshot.items) items.push({...item,schedule_source:key,schedule_source_version:snapshot.source_version,schedule_source_as_of:asOf});
      } catch (error) {
        if (registration.isUnavailableError && !registration.isUnavailableError(error)) throw error;
        sources.push({key,status:'unavailable',source_version:null,as_of:null,item_count:0});
      }
    }
    const observed = new Date(Math.floor(clock().getTime()/60_000)*60_000).toISOString();
    const version = createHash('sha256').update(JSON.stringify([weekOf,observed,sources])).digest('hex');
    return {as_of:observed,source_version:`schedule:registered-sources:v1:${version}`,items,sources} satisfies RegisteredSchedule;
  } };
}

/** Explicit event adapter. It returns only the authenticated resident's current
 * attending RSVPs; the registry labels this adapter unavailable before WP-012's
 * tables exist rather than pretending the resident has no events. */
export function createPostgresEventScheduleSource(client: DatabaseClient, clock: () => Date = () => new Date()): ScheduleSource {
  return { read(identity,weekOf) {
    if (!uuid.test(identity.orgId) || !uuid.test(identity.userId) || !validWeek(weekOf)) throw new Error('Unavailable');
    const start = new Date(`${weekOf}T00:00:00.000Z`);
    const end = new Date(start.getTime()+7*86_400_000);
    return withOrg(client,identity.orgId,async sql => {
      await sql`select set_config('app.current_user_id',${identity.userId},true)`;
      const active = await sql<{id:string}[]>`select id from users where org_id=${identity.orgId} and id=${identity.userId} and account_state='active'`;
      if (active.length !== 1) throw new Error('Unavailable');
      const rows = await sql<{id:string;title:string;starts_at:Date;time_zone:string;location:string}[]>`
        select e.id,e.title,e.starts_at,e.time_zone,e.location from event_rsvps r join events e
          on e.org_id=r.org_id and e.id=r.event_id
        where r.org_id=${identity.orgId} and r.user_id=${identity.userId} and r.state='attending'
          and e.published_at is not null and e.starts_at>=${start} and e.starts_at<${end}
        order by e.starts_at,e.id`;
      const observed = new Date(Math.floor(clock().getTime()/60_000)*60_000).toISOString();
      const items = rows.map(row => ({id:row.id,kind:'event',title:row.title,starts_at:row.starts_at.toISOString(),time_zone:row.time_zone,location:row.location}));
      const version = createHash('sha256').update(JSON.stringify([weekOf,observed,items])).digest('hex');
      return {as_of:observed,source_version:`events:v1:${version}`,items};
    });
  } };
}

export function createPublicScheduleSource(client: DatabaseClient, clock: () => Date = () => new Date()): ScheduleSource {
  return createRegisteredScheduleSource([{key:'events',source:createPostgresEventScheduleSource(client,clock)}],clock);
}
export function createPrintService(client: DatabaseClient, source: ScheduleSource = createCurrentScheduleSource()) {
  const repository = createResidentRepository(client);
  const noExtraSession = () => Promise.resolve();
  const validate = (identity: Identity, payload: PrintPayload) => {
    if (!validPrintPayload(payload) || identity.orgId !== payload.org_id || identity.userId !== payload.user_id) throw new Error('Unavailable');
  };
  return {
    request(identity: Identity, payload: PrintPayload, recheck: () => Promise<void>) {
      validate(identity,payload);
      return repository.requestPrint(identity,payload.week_of,payload.idempotency_key,recheck);
    },
    async render(identity: Identity, payload: PrintPayload, recheck: () => Promise<void>) {
      validate(identity,payload);
      await repository.requestPrint(identity,payload.week_of,payload.idempotency_key,recheck);
      return repository.renderPrint(identity,payload.week_of,payload.idempotency_key,() => source.read(identity,payload.week_of),recheck,true);
    },
    consume(identity: Identity, payload: PrintPayload) {
      validate(identity,payload);
      return repository.renderPrint(identity,payload.week_of,payload.idempotency_key,() => source.read(identity,payload.week_of),noExtraSession,true);
    },
    current(identity: Identity, weekOf = currentWeek(), recheck = noExtraSession) {
      if (!validWeek(weekOf)) throw new Error('Unavailable');
      return repository.renderPrint(identity,weekOf,undefined,() => source.read(identity,weekOf),recheck);
    },
  };
}
export type PrintService = ReturnType<typeof createPrintService>;
