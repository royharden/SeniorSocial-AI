import { appendAudit } from '@seniorsocial/audit';
import { withOrg, type DatabaseClient, type TenantTransaction } from '@seniorsocial/db';
import { ConflictError } from './types.ts';
import type {
  AssistanceRepository, AssistanceRequest, AssistanceState, AssistanceTransaction,
  AuditIntent, NarrativeCodec, NewRequest, TriageCategory, TriageSource,
} from './types.ts';

interface RequestRow {
  id: string; org_id: string; requester_id: string; summary_ciphertext: string; locale: 'en' | 'es';
  triage_category: TriageCategory; triage_source: TriageSource; state: AssistanceState;
  owner_id: string | null; after_hours: boolean; sla_due_at: string; sla_breached_at: string | null; created_at: string;
}

export class PostgresAssistanceRepository implements AssistanceRepository {
  constructor(private readonly client: DatabaseClient, private readonly codec: NarrativeCodec) {}

  transaction<T>(orgId: string, work: (transaction: AssistanceTransaction) => Promise<T>): Promise<T> {
    return withOrg(this.client, orgId, sql => work(this.adapter(sql, orgId)));
  }

  private adapter(sql: TenantTransaction, orgId: string): AssistanceTransaction {
    const hydrate = async (row: RequestRow): Promise<AssistanceRequest> => ({
      id: row.id, orgId: row.org_id, requesterId: row.requester_id,
      summary: await this.codec.open(row.summary_ciphertext), locale: row.locale,
      triageCategory: row.triage_category, triageSource: row.triage_source, state: row.state,
      ownerId: row.owner_id, afterHours: row.after_hours, slaDueAt: new Date(row.sla_due_at),
      slaBreachedAt: row.sla_breached_at ? new Date(row.sla_breached_at) : null, createdAt: new Date(row.created_at),
    });
    const select = async (query: PromiseLike<RequestRow[]>) => Promise.all((await query).map(hydrate));
    return {
      insert: async (request: NewRequest, idempotencyKey: string) => {
        const rows = await sql<RequestRow[]>`
          insert into assistance_requests (id, org_id, requester_id, summary_ciphertext, locale, triage_category, triage_source, after_hours, idempotency_key, created_at)
          values (${request.id}, ${orgId}, ${request.requesterId}, ${request.summaryCiphertext}, ${request.locale}, ${request.triageCategory}, ${request.triageSource}, ${request.afterHours}, ${idempotencyKey}, ${request.createdAt})
          on conflict (org_id, requester_id, idempotency_key) do nothing
          returning id, org_id, requester_id, summary_ciphertext, locale, triage_category, triage_source,
            'pending_unowned'::text as state, null::uuid as owner_id, after_hours,
            ${request.slaDueAt}::timestamptz::text as sla_due_at, null::text as sla_breached_at, created_at::text
        `;
        const inserted = rows[0];
        if (inserted) {
          await sql`insert into assistance_transitions (org_id, request_id, actor_id, from_state, to_state, owner_id, reason, at)
            values (${orgId}, ${request.id}, ${request.requesterId}, null, 'pending_unowned', null, 'request_opened', ${request.createdAt})`;
          await sql`insert into sla_clocks (org_id, request_id, due_at) values (${orgId}, ${request.id}, ${request.slaDueAt})`;
          return { request: await hydrate(inserted), created: true };
        }
        const existing = await this.findRows(sql, orgId, request.requesterId, idempotencyKey);
        if (!existing[0]) throw new Error('idempotent assistance request lookup failed');
        return { request: await hydrate(existing[0]), created: false };
      },
      find: async id => {
        const rows = await select(sql<RequestRow[]>`${this.baseQuery(sql)} where r.org_id = ${orgId} and r.id = ${id} limit 1`);
        return rows[0] ?? null;
      },
      listForRequester: async requesterId => select(sql<RequestRow[]>`${this.baseQuery(sql)} where r.org_id = ${orgId} and r.requester_id = ${requesterId} order by r.created_at desc, r.id desc`),
      listQueue: async () => select(sql<RequestRow[]>`${this.baseQuery(sql)} where r.org_id = ${orgId} and latest.to_state not in ('resolved', 'closed_unable') order by clock.due_at, r.created_at, r.id`),
      transition: async (id, expected, to, ownerId, actorId, reason) => {
        const rows = await sql<RequestRow[]>`
          with inserted as (
            insert into assistance_transitions (org_id, request_id, actor_id, from_state, to_state, owner_id, reason)
            select ${orgId}, ${id}, ${actorId}, ${expected}, ${to}, ${ownerId}, ${reason}
            where (select t.to_state from assistance_transitions t where t.org_id = ${orgId} and t.request_id = ${id} order by t.sequence desc limit 1) = ${expected}
            returning request_id, to_state, owner_id
          )
          select r.id, r.org_id, r.requester_id, r.summary_ciphertext, r.locale, r.triage_category, r.triage_source,
            i.to_state as state, i.owner_id, r.after_hours, clock.due_at::text as sla_due_at,
            clock.breached_at::text as sla_breached_at, r.created_at::text as created_at
          from assistance_requests r
          join inserted i on i.request_id = r.id
          join sla_clocks clock on clock.org_id = r.org_id and clock.request_id = r.id
          where r.org_id = ${orgId}
        `;
        if (!rows[0]) throw new ConflictError('stale_transition');
        return hydrate(rows[0]);
      },
      markBreached: async (id, at) => {
        const rows = await sql<RequestRow[]>`
          with updated as (
            update sla_clocks set breached_at = ${at}
            where org_id = ${orgId} and request_id = ${id} and breached_at is null and due_at <= ${at}
            returning request_id
          )
          ${this.baseQuery(sql)} join updated u on u.request_id = r.id where r.org_id = ${orgId}
        `;
        if (rows[0]) return { request: await hydrate(rows[0]), created: true };
        const existing = await sql<RequestRow[]>`${this.baseQuery(sql)} where r.org_id = ${orgId} and r.id = ${id} limit 1`;
        if (!existing[0]?.sla_breached_at) throw new ConflictError('stale_sla_tick');
        return { request: await hydrate(existing[0]), created: false };
      },
      audit: async (intent: AuditIntent) => { await appendAudit(sql, intent); },
    };
  }

  private baseQuery(sql: TenantTransaction) {
    return sql`
      select r.id, r.org_id, r.requester_id, r.summary_ciphertext, r.locale, r.triage_category, r.triage_source,
        latest.to_state as state, latest.owner_id, r.after_hours, clock.due_at::text as sla_due_at,
        clock.breached_at::text as sla_breached_at, r.created_at::text as created_at
      from assistance_requests r
      join lateral (select t.to_state, t.owner_id from assistance_transitions t where t.org_id = r.org_id and t.request_id = r.id order by t.sequence desc limit 1) latest on true
      join sla_clocks clock on clock.org_id = r.org_id and clock.request_id = r.id
    `;
  }

  private async findRows(sql: TenantTransaction, orgId: string, requesterId: string, key: string): Promise<RequestRow[]> {
    return sql<RequestRow[]>`${this.baseQuery(sql)} where r.org_id = ${orgId} and r.requester_id = ${requesterId} and r.idempotency_key = ${key} limit 1`;
  }
}
