import { withOrg, type DatabaseClient, type TenantTransaction } from '@seniorsocial/db';
import { defaultPreferences, parsePreferences } from './preferences.ts';
import type { AuditIntent, Identity, Job, PendingAudit, Repository, Transaction } from './types.ts';

interface JobRow {
  id: string; org_id: string; user_id: string; actor_id: string; channel: Job['channel'];
  payload: Job['payload']; state: Job['state']; due_at: Date; attempts: number; synthetic: boolean;
}
const fromRow = (row: JobRow): Job => ({ id: row.id, orgId: row.org_id, userId: row.user_id, actorId: row.actor_id,
  channel: row.channel, payload: row.payload, state: row.state, dueAt: row.due_at, attempts: row.attempts, synthetic: row.synthetic });

export function createPostgresRepository(client: DatabaseClient): Repository {
  async function tenant<T>(identity: Identity, work: (sql: TenantTransaction) => Promise<T>) {
    return withOrg(client, identity.orgId, async sql => {
      const roles = await sql<{ unsafe: boolean }[]>`select r.rolsuper or r.rolbypassrls or
        exists(select 1 from pg_class c where c.relname = 'notification_outbox' and c.relowner = r.oid) as unsafe
        from pg_roles r where r.rolname = current_user`;
      if (roles[0]?.unsafe !== false) throw new Error('Notification repository requires non-owner RLS role');
      return work(sql);
    });
  }
  return {
    async transaction<T>(identity: Identity, work: (tx: Transaction) => Promise<T>): Promise<T> {
      return tenant(identity, async sql => {
        await sql`select pg_advisory_xact_lock(hashtextextended(${`${identity.orgId}:${identity.userId}`}, 0))`;
        const tx: Transaction = {
          async preferences() {
            const rows = await sql<{ preferences: unknown }[]>`select preferences from notification_preferences where org_id = ${identity.orgId} and user_id = ${identity.userId}`;
            return rows[0] ? parsePreferences(rows[0].preferences) : defaultPreferences();
          },
          async savePreferences(preferences) {
            await sql`insert into notification_preferences (org_id, user_id, preferences)
              values (${identity.orgId}, ${identity.userId}, ${JSON.stringify(preferences)}::text::jsonb)
              on conflict (org_id, user_id) do update set preferences = excluded.preferences`;
          },
          async insert(job) {
            if (job.orgId !== identity.orgId || job.userId !== identity.userId) throw new Error('Notification scope mismatch');
            const rows = await sql<JobRow[]>`insert into notification_outbox
              (id, org_id, user_id, actor_id, channel, idempotency_key, payload, state, due_at, attempts, synthetic)
              values (${job.id}, ${identity.orgId}, ${identity.userId}, ${job.actorId}, ${job.channel}, ${job.payload.idempotency_key},
                ${JSON.stringify(job.payload)}::text::jsonb, ${job.state}, ${job.dueAt}, ${job.attempts}, ${job.synthetic})
              on conflict (org_id, user_id, channel, idempotency_key) do nothing returning *`;
            if (rows[0]) return fromRow(rows[0]);
            const existing = await sql<JobRow[]>`select * from notification_outbox where org_id = ${identity.orgId} and user_id = ${identity.userId}
              and channel = ${job.channel} and idempotency_key = ${job.payload.idempotency_key}`;
            if (!existing[0]) throw new Error('Notification conflict');
            return fromRow(existing[0]);
          },
          async job(id) {
            const rows = await sql<JobRow[]>`select * from notification_outbox where org_id = ${identity.orgId} and user_id = ${identity.userId} and id = ${id}`;
            return rows[0] ? fromRow(rows[0]) : null;
          },
          async save(job) {
            await sql`update notification_outbox set state = ${job.state}, due_at = ${job.dueAt}, attempts = ${job.attempts}
              where org_id = ${identity.orgId} and user_id = ${identity.userId} and id = ${job.id}`;
          },
          async attempt(attempt) {
            await sql`insert into notification_attempts (id, org_id, user_id, job_id, sequence, outcome, synthetic)
              values (${attempt.id}, ${identity.orgId}, ${identity.userId}, ${attempt.jobId}, ${attempt.sequence}, ${attempt.outcome}, ${attempt.synthetic})`;
          },
          async audit(intent) {
            if (intent.org_id !== identity.orgId) throw new Error('Notification audit scope mismatch');
            await sql`insert into notification_audit_pending (org_id, user_id, intent) values (${identity.orgId}, ${identity.userId}, ${JSON.stringify(intent)}::text::jsonb)`;
          },
        };
        return work(tx);
      });
    },
    async pendingAudits(identity): Promise<PendingAudit[]> {
      return tenant(identity, sql => sql<{ id: string; intent: AuditIntent }[]>`select id, intent from notification_audit_pending
        where org_id = ${identity.orgId} and user_id = ${identity.userId} and not emitted order by created_at, id`);
    },
    async acknowledgeAudit(identity, id) {
      await tenant(identity, sql => sql`update notification_audit_pending set emitted = true
        where org_id = ${identity.orgId} and user_id = ${identity.userId} and id = ${id} and not emitted`);
    },
    async schedulable(identity) {
      return tenant(identity, async sql => {
        await sql`select set_config('app.current_user_id', ${identity.userId}, true)`;
        return (await sql<JobRow[]>`select o.* from notification_outbox o
          where o.org_id = ${identity.orgId} and o.user_id = ${identity.userId}
            and (o.state in ('pending', 'send_failed') or
              (o.state = 'delivered' and o.payload->>'purpose' = 'event_reminder' and not exists (
                select 1 from notification_inbox i where i.org_id = o.org_id and i.user_id = o.user_id
                  and i.source_key = 'event-reminder:' || coalesce(o.payload->>'resource_id',o.payload->'params'->>'event_id')
              )))
          order by o.due_at, o.id`).map(fromRow);
      });
    },
  };
}
