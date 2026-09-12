import { createHash } from 'node:crypto';
import { withOrg, type DatabaseClient } from '@seniorsocial/db';
import type { PrintableSchedule } from '../../contracts/src/types.ts';
import type { AssistanceRequest } from './types.ts';

export const assistanceScheduleSourceKey = 'assistance' as const;
export const assistanceScheduleUnavailable = 'assistance_schedule_unavailable' as const;

export interface AssistanceScheduleIdentity {
  readonly orgId: string;
  readonly userId: string;
}

export interface AssistanceScheduleSource {
  read(identity: AssistanceScheduleIdentity, weekOf: string): Promise<PrintableSchedule>;
}

export interface AssistanceScheduleSourceRegistration {
  readonly key: typeof assistanceScheduleSourceKey;
  readonly source: AssistanceScheduleSource;
}

export interface AssistanceScheduleRequest {
  readonly id: string;
  readonly orgId: string;
  readonly requesterId: string;
  readonly state: AssistanceRequest['state'];
  readonly triageCategory: AssistanceRequest['triageCategory'];
  readonly createdAt: Date;
  readonly slaDueAt: Date;
  readonly slaBreachedAt: Date | null;
}

export interface AssistanceScheduleReadPort {
  listPending(identity: AssistanceScheduleIdentity, start: Date, end: Date): Promise<readonly AssistanceScheduleRequest[]>;
}

export class AssistanceScheduleUnavailableError extends Error {
  readonly code = assistanceScheduleUnavailable;

  constructor(cause?: unknown) {
    super(assistanceScheduleUnavailable, cause === undefined ? undefined : { cause });
    this.name = 'AssistanceScheduleUnavailableError';
  }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const monday = /^\d{4}-\d{2}-\d{2}$/u;
const pendingStates = new Set<AssistanceScheduleRequest['state']>(['pending_unowned', 'owned', 'in_progress']);

function weekBounds(weekOf: string): { start: Date; end: Date } {
  if (!monday.test(weekOf)) throw new AssistanceScheduleUnavailableError();
  const start = new Date(`${weekOf}T00:00:00.000Z`);
  if (!Number.isFinite(start.getTime()) || start.toISOString().slice(0, 10) !== weekOf || start.getUTCDay() !== 1) {
    throw new AssistanceScheduleUnavailableError();
  }
  return { start, end: new Date(start.getTime() + 7 * 86_400_000) };
}

function validIdentity(identity: AssistanceScheduleIdentity): boolean {
  return uuid.test(identity.orgId) && uuid.test(identity.userId);
}

function pending(request: AssistanceScheduleRequest, identity: AssistanceScheduleIdentity, end: Date): boolean {
  // Unresolved requests remain active after their SLA deadline. Their active
  // interval has no end yet, so even older overdue requests intersect this week.
  return request.orgId === identity.orgId && request.requesterId === identity.userId && pendingStates.has(request.state)
    && Number.isFinite(request.createdAt.getTime()) && Number.isFinite(request.slaDueAt.getTime())
    && (request.slaBreachedAt === null || Number.isFinite(request.slaBreachedAt.getTime()))
    && request.createdAt.getTime() < end.getTime();
}

function item(request: AssistanceScheduleRequest): Record<string, unknown> {
  return {
    id: request.id,
    kind: assistanceScheduleSourceKey,
    state: request.state,
    triage_category: request.triageCategory,
    requested_at: request.createdAt.toISOString(),
    sla_due_at: request.slaDueAt.toISOString(),
    ...(request.slaBreachedAt ? { sla_breached_at: request.slaBreachedAt.toISOString() } : {}),
  };
}

/** Composes a non-sensitive read projection as a schedule source. The port and
 * this adapter both scope by tenant/resident; narrative and ownership fields do
 * not exist in this boundary, so they cannot be accidentally emitted. */
export function createAssistanceScheduleSource(
  repository: AssistanceScheduleReadPort,
  clock: () => Date = () => new Date(),
): AssistanceScheduleSourceRegistration {
  return {
    key: assistanceScheduleSourceKey,
    source: {
      async read(identity, weekOf) {
        if (!validIdentity(identity)) throw new AssistanceScheduleUnavailableError();
        const { start, end } = weekBounds(weekOf);
        const rows = await repository.listPending(identity, start, end);
        const items = rows
          .filter(row => pending(row, identity, end))
          .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id))
          .map(item);
        const observed = clock();
        if (!Number.isFinite(observed.getTime())) throw new Error('invalid assistance schedule clock');
        const asOf = observed.toISOString();
        const digest = createHash('sha256').update(JSON.stringify([weekOf, items])).digest('hex');
        return { as_of: asOf, source_version: `assistance:v1:${digest}`, items };
      },
    },
  };
}

interface AssistanceScheduleRow {
  id: string;
  org_id: string;
  requester_id: string;
  state: AssistanceScheduleRequest['state'];
  triage_category: AssistanceScheduleRequest['triageCategory'];
  created_at: string;
  sla_due_at: string;
  sla_breached_at: string | null;
}

function dateFromDatabase(value: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new RangeError('invalid assistance schedule row date');
  return date;
}

/** D1 registration seam. The query intentionally selects no encrypted
 * narrative, owner, triage provenance, or locale column. */
export function createPostgresAssistanceScheduleAdapter(
  client: DatabaseClient,
  clock: () => Date = () => new Date(),
): AssistanceScheduleSourceRegistration {
  const repository: AssistanceScheduleReadPort = {
    listPending: (identity, _start, end) => withOrg(client, identity.orgId, async sql => {
      const rows = await sql<AssistanceScheduleRow[]>`
        select r.id, r.org_id, r.requester_id, latest.to_state as state, r.triage_category,
          r.created_at::text, clock.due_at::text as sla_due_at,
          clock.breached_at::text as sla_breached_at
        from assistance_requests r
        join lateral (
          select transition.to_state from assistance_transitions transition
          where transition.org_id = r.org_id and transition.request_id = r.id
          order by transition.sequence desc limit 1
        ) latest on true
        join sla_clocks clock on clock.org_id = r.org_id and clock.request_id = r.id
        where r.org_id = ${identity.orgId} and r.requester_id = ${identity.userId}
          and latest.to_state in ('pending_unowned', 'owned', 'in_progress')
          and r.created_at < ${end}
        order by r.created_at, r.id
      `;
      return rows.map(row => ({
        id: row.id,
        orgId: row.org_id,
        requesterId: row.requester_id,
        state: row.state,
        triageCategory: row.triage_category,
        createdAt: dateFromDatabase(row.created_at),
        slaDueAt: dateFromDatabase(row.sla_due_at),
        slaBreachedAt: row.sla_breached_at === null ? null : dateFromDatabase(row.sla_breached_at),
      }));
    }),
  };
  return createAssistanceScheduleSource(repository, clock);
}
