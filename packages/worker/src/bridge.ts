import type { PgBoss } from 'pg-boss';
export { PgBoss } from 'pg-boss';
import { withOrg, type DatabaseClient } from '@seniorsocial/db';
import { channels, purposes, type Identity, type JobQueue, type Notify, type Payload } from '@seniorsocial/notify';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function validPayload(value: unknown): value is Payload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const p = value as Partial<Payload>;
  return typeof p.org_id === 'string' && uuid.test(p.org_id) && typeof p.user_id === 'string' && uuid.test(p.user_id)
    && typeof p.idempotency_key === 'string' && /^[a-f0-9]{64}$/.test(p.idempotency_key)
    && purposes.includes(p.purpose!) && (p.locale === 'en' || p.locale === 'es')
    && typeof p.template === 'string' && /^[a-z][a-z0-9_.-]{0,79}$/.test(p.template)
    && !!p.params && typeof p.params === 'object' && !Array.isArray(p.params)
    && Object.keys(p.params).length <= 20 && Object.entries(p.params).every(([k,v]) => /^[a-z][a-z0-9_]{0,39}$/.test(k) && typeof v === 'string' && v.length <= 1000);
}
export function createBossQueue(boss: Pick<PgBoss, 'send'>): JobQueue {
  return { async enqueue(name, payload, dueAt) {
    if (!channels.some(c => name === `notify.send.${c}`) || !validPayload(payload) || !Number.isFinite(dueAt.getTime())) throw new Error('Notification unavailable');
    await boss.send(name, payload, { singletonKey: payload.idempotency_key, startAfter: dueAt, retryLimit: 5, retryDelay: 60 });
  } };
}
export interface WorkerLookup { find(identity: Identity, channel: string, payload: Payload): Promise<string | null> }
export function postgresWorkerLookup(client: DatabaseClient): WorkerLookup {
  return { find: (identity, channel, payload) => withOrg(client, identity.orgId, async sql => {
    const rows = await sql<{id: string}[]>`select id from notification_outbox where org_id = ${identity.orgId} and user_id = ${identity.userId}
      and channel = ${channel} and idempotency_key = ${payload.idempotency_key} and payload = ${JSON.stringify(payload)}::text::jsonb`;
    return rows[0]?.id ?? null;
  }) };
}
export function createConsumer(lookup: WorkerLookup, notify: Pick<Notify, 'send'>, trustedOrgId: string) {
  return async (name: string, data: unknown) => {
    const channel = channels.find(c => name === `notify.send.${c}`);
    if (!channel || !validPayload(data) || !uuid.test(trustedOrgId) || data.org_id !== trustedOrgId) throw new Error('Notification unavailable');
    const identity = { orgId: data.org_id, userId: data.user_id };
    const id = await lookup.find(identity, channel, data);
    if (!id) throw new Error('Notification unavailable');
    const result = await notify.send(identity, id);
    // A queue acknowledgement is never a delivery receipt. Durable ambiguous and
    // sending states are deliberately not replayed after a process interruption.
    if (result.status === 'send_failed' || result.status === 'pending') throw new Error('Notification retry required');
    return result;
  };
}
export async function registerConsumers(boss: PgBoss, consume: ReturnType<typeof createConsumer>) {
  for (const channel of channels) {
    const name = `notify.send.${channel}` as const;
    await boss.createQueue(name, { policy: 'exclusive' });
    if ((await boss.getQueue(name))?.policy !== 'exclusive') throw new Error('Notification queue policy requires explicit migration');
    await boss.work<Payload>(name, async jobs => { for (const job of jobs) await consume(name, job.data); });
  }
}
