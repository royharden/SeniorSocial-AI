import { createHash, randomUUID } from 'node:crypto';
import type { TenantTransaction } from '../../db/src/index.ts';
import { defaultPreferences, nextDeliveryAt, parsePreferences, permits } from '../../notify/src/preferences.ts';

/** This port has no body/note/sender-name fields. It participates in the send
 * transaction so crashes cannot strand a committed message without its notice.
 * WP-009 recover/worker drains the resulting durable outbox, never this package.
 */
export interface NoticeRequest { orgId: string; actorId: string; recipientId: string; conversationId: string; messageId: string; at: Date }
export interface MessageNotices { enqueue(sql: TenantTransaction, request: NoticeRequest): Promise<void> }
export const wp009Notices: MessageNotices = {
  async enqueue(sql, request) {
    // Same recipient lock as WP-009 preference writes. Lock order is messaging
    // org lock, then recipient lock; WP-009 never acquires messaging locks.
    await sql`select pg_advisory_xact_lock(hashtextextended(${`${request.orgId}:${request.recipientId}`}, 0))`;
    const row = (await sql<{ preferences: unknown }[]>`select preferences from notification_preferences
      where org_id = ${request.orgId} and user_id = ${request.recipientId}`)[0];
    const preferences = row ? parsePreferences(row.preferences) : defaultPreferences();
    for (const channel of ['email', 'sms', 'voice'] as const) {
      if (!permits(preferences, 'message', channel)) continue;
      const key = createHash('sha256').update(JSON.stringify([request.orgId, request.recipientId, channel, request.messageId])).digest('hex');
      const payload = { org_id: request.orgId, user_id: request.recipientId, purpose: 'message', template: 'message.received',
        locale: preferences.locale, params: {}, resource_id: request.conversationId, idempotency_key: key };
      const inserted = await sql<{ id: string }[]>`insert into notification_outbox
        (id, org_id, user_id, actor_id, channel, idempotency_key, payload, state, due_at, attempts, synthetic)
        values (${randomUUID()}, ${request.orgId}, ${request.recipientId}, ${request.actorId}, ${channel}, ${key},
          ${JSON.stringify(payload)}::text::jsonb, 'pending', ${nextDeliveryAt(request.at, preferences, 'message')}, 0, true)
        on conflict (org_id, user_id, channel, idempotency_key) do nothing returning id`;
      if (inserted[0]) {
        const intent = { actor: `user:${request.actorId}`, on_behalf_of: null, action: 'notification.queued',
          target: `notification:${inserted[0].id}`, org_id: request.orgId, outcome: 'allowed', reason: 'notification_queued' };
        await sql`insert into notification_audit_pending (org_id, user_id, intent)
          values (${request.orgId}, ${request.recipientId}, ${JSON.stringify(intent)}::text::jsonb)`;
      }
    }
  },
};
