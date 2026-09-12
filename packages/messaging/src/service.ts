import { randomUUID } from 'node:crypto';
import { withOrg, type DatabaseClient, type TenantTransaction } from '../../db/src/index.ts';
import type { MessageNotices } from './notices.ts';

export interface MessagingIdentity { orgId: string; userId: string }
export interface Conversation { id: string; participant_ids: string[] }
export interface Message { id: string; body: string; sent_at: string }
interface ConversationRow { id: string; participant_a: string; participant_b: string }
interface MessageRow { id: string; body: string; sent_at: Date }
interface ReportRow { id: string; conversation_id: string; reason: string; note: string; state: 'open' | 'decided' }
export class MessagingError extends Error {
  constructor(readonly status: 404 | 409 | 422 | 503) { super(status === 404 ? 'not_found' : status === 409 ? 'conflict' : status === 422 ? 'invalid_input' : 'unavailable'); }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const keyPattern = /^[A-Za-z0-9._~-]{1,160}$/;
const view = (row: ConversationRow): Conversation => ({ id: row.id, participant_ids: [row.participant_a, row.participant_b] });
const messageView = (row: MessageRow): Message => ({ id: row.id, body: row.body, sent_at: row.sent_at.toISOString() });
function identifier(value: string) { if (!uuid.test(value)) throw new MessagingError(404); }
function key(value: string) { if (!keyPattern.test(value)) throw new MessagingError(422); }
export function textInput(value: unknown, limit: number, optional = false): string {
  if (optional && value === undefined) return '';
  if (typeof value !== 'string' || (!optional && !value.trim()) || value.length > limit || value.includes('\0')) throw new MessagingError(422);
  return value;
}
export function createMessaging(client: DatabaseClient, notices: MessageNotices) {
  async function scoped<T>(identity: MessagingIdentity, work: (sql: TenantTransaction) => Promise<T>): Promise<T> {
    identifier(identity.orgId); identifier(identity.userId);
    try {
      return await withOrg(client, identity.orgId, async sql => {
        const role = (await sql<{ unsafe: boolean; isolation: string }[]>`select r.rolsuper or r.rolbypassrls or
          exists(select 1 from pg_class c where c.relname = 'messaging_messages' and c.relowner = r.oid) as unsafe
          , current_setting('transaction_isolation') as isolation
          from pg_roles r where r.rolname = current_user`)[0];
        if (role?.unsafe !== false || role.isolation !== 'read committed') throw new MessagingError(503);
        // One tenant lock also serializes listing with all block mutations. Small
        // community workload: intentional simple linearizable boundary, not a cache.
        await sql`select pg_advisory_xact_lock(hashtextextended(${`messaging:${identity.orgId}`}, 0))`;
        await sql`select set_config('app.current_user_id', ${identity.userId}, true)`;
        const active = await sql`select id from users where org_id = ${identity.orgId} and id = ${identity.userId} and account_state = 'active'`;
        if (!active.length) throw new MessagingError(404);
        return work(sql);
      });
    } catch (error) {
      // Driver errors can contain SQL parameters and message bodies. Never expose
      // a cause, log, or rethrow the original driver error across this boundary.
      if (error instanceof MessagingError) throw error;
      throw new MessagingError(503);
    }
  }
  async function allowedPair(sql: TenantTransaction, identity: MessagingIdentity, other: string): Promise<boolean> {
    const active = await sql`select id from users where org_id = ${identity.orgId} and id = ${other} and account_state = 'active'`;
    if (!active.length) return false;
    const block = await sql`select 1 from blocks where org_id = ${identity.orgId} and
      ((blocker_id = ${identity.userId} and blocked_id = ${other}) or (blocker_id = ${other} and blocked_id = ${identity.userId}))`;
    return !block.length;
  }
  async function conversation(sql: TenantTransaction, identity: MessagingIdentity, id: string): Promise<ConversationRow> {
    const row = (await sql<ConversationRow[]>`select id, participant_a, participant_b from messaging_conversations
      where org_id = ${identity.orgId} and id = ${id} and ${identity.userId} in (participant_a, participant_b)`)[0];
    if (!row || !await allowedPair(sql, identity, row.participant_a === identity.userId ? row.participant_b : row.participant_a)) throw new MessagingError(404);
    return row;
  }
  return {
    async list(identity: MessagingIdentity) {
      return scoped(identity, async sql => {
        const rows = await sql<ConversationRow[]>`select c.id, c.participant_a, c.participant_b from messaging_conversations c
          where c.org_id = ${identity.orgId} and ${identity.userId} in (c.participant_a, c.participant_b)
          and exists(select 1 from users u where u.org_id = c.org_id and u.id = case when c.participant_a = ${identity.userId} then c.participant_b else c.participant_a end and u.account_state = 'active')
          and not exists(select 1 from blocks b where b.org_id = c.org_id and
            ((b.blocker_id = c.participant_a and b.blocked_id = c.participant_b) or (b.blocker_id = c.participant_b and b.blocked_id = c.participant_a)))
          order by c.created_at, c.id`;
        return { items: rows.map(view), meta: { next_cursor: null, total_known: true } };
      });
    },
    async create(identity: MessagingIdentity, participantId: string): Promise<Conversation> {
      identifier(participantId);
      participantId = participantId.toLowerCase();
      if (participantId === identity.userId) throw new MessagingError(422);
      return scoped(identity, async sql => {
        if (!await allowedPair(sql, identity, participantId)) throw new MessagingError(404);
        const pair = [identity.userId, participantId].sort();
        const previous = (await sql<ConversationRow[]>`select id, participant_a, participant_b from messaging_conversations
          where org_id = ${identity.orgId} and participant_a = ${pair[0]!} and participant_b = ${pair[1]!}`)[0];
        if (previous) return view(previous);
        const row = (await sql<ConversationRow[]>`insert into messaging_conversations (id, org_id, participant_a, participant_b)
          values (${randomUUID()}, ${identity.orgId}, ${pair[0]!}, ${pair[1]!}) returning id, participant_a, participant_b`)[0]!;
        return view(row);
      });
    },
    async messages(identity: MessagingIdentity, id: string) {
      identifier(id);
      return scoped(identity, async sql => {
        await conversation(sql, identity, id);
        const rows = await sql<MessageRow[]>`select id, body, sent_at from messaging_messages where org_id = ${identity.orgId}
          and conversation_id = ${id} order by sent_at, id`;
        return { items: rows.map(messageView), meta: { next_cursor: null, total_known: true } };
      });
    },
    async send(identity: MessagingIdentity, id: string, body: unknown, idempotencyKey: string): Promise<Message> {
      identifier(id); key(idempotencyKey); const text = textInput(body, 4000);
      return scoped(identity, async sql => {
        const row = await conversation(sql, identity, id);
        const prior = (await sql<MessageRow[]>`select id, body, sent_at from messaging_messages where org_id = ${identity.orgId}
          and conversation_id = ${id} and sender_id = ${identity.userId} and idempotency_key = ${idempotencyKey}`)[0];
        if (prior) { if (prior.body !== text) throw new MessagingError(409); return messageView(prior); }
        const sent = (await sql<MessageRow[]>`insert into messaging_messages (org_id, conversation_id, sender_id, body, idempotency_key)
          values (${identity.orgId}, ${id}, ${identity.userId}, ${text}, ${idempotencyKey}) returning id, body, sent_at`)[0]!;
        await notices.enqueue(sql, { orgId: identity.orgId, actorId: identity.userId, recipientId: row.participant_a === identity.userId ? row.participant_b : row.participant_a, conversationId: id, messageId: sent.id, at: sent.sent_at });
        return messageView(sent);
      });
    },
    async report(identity: MessagingIdentity, id: string, input: { reason?: unknown; note?: unknown }, idempotencyKey: string) {
      identifier(id); key(idempotencyKey);
      const reason = textInput(input.reason, 200); const note = textInput(input.note, 2000, true);
      return scoped(identity, async sql => {
        await conversation(sql, identity, id);
        const prior = (await sql<ReportRow[]>`select id, conversation_id, reason, note, state from messaging_reports
          where org_id = ${identity.orgId} and reporter_id = ${identity.userId}
          and (conversation_id = ${id} or id in (select report_id from messaging_report_keys where org_id = ${identity.orgId}
            and reporter_id = ${identity.userId} and idempotency_key = ${idempotencyKey})) order by (conversation_id <> ${id}) desc`)[0];
        if (prior) {
          if (prior.conversation_id !== id || prior.reason !== reason || prior.note !== note) throw new MessagingError(409);
          await sql`insert into messaging_report_keys (org_id, reporter_id, idempotency_key, report_id)
            values (${identity.orgId}, ${identity.userId}, ${idempotencyKey}, ${prior.id}) on conflict do nothing`;
          return { id: prior.id, state: prior.state };
        }
        const row = (await sql<ReportRow[]>`insert into messaging_reports (org_id, conversation_id, reporter_id, reason, note, idempotency_key)
          values (${identity.orgId}, ${id}, ${identity.userId}, ${reason}, ${note}, ${idempotencyKey}) returning id, state`)[0]!;
        await sql`insert into messaging_report_keys (org_id, reporter_id, idempotency_key, report_id)
          values (${identity.orgId}, ${identity.userId}, ${idempotencyKey}, ${row.id})`;
        return { id: row.id, state: row.state };
      });
    },
    async block(identity: MessagingIdentity, target: string) {
      identifier(target); target = target.toLowerCase(); if (target === identity.userId) throw new MessagingError(422);
      return scoped(identity, async sql => {
        const user = await sql`select id from users where org_id = ${identity.orgId} and id = ${target} and account_state = 'active'`;
        if (!user.length) throw new MessagingError(404);
        await sql`insert into blocks (org_id, blocker_id, blocked_id) values (${identity.orgId}, ${identity.userId}, ${target}) on conflict do nothing`;
        return { user_id: target };
      });
    },
    async blocks(identity: MessagingIdentity) {
      return scoped(identity, async sql => ({ items: await sql<{ user_id: string }[]>`select blocked_id as user_id from blocks
        where org_id = ${identity.orgId} and blocker_id = ${identity.userId} order by created_at, blocked_id` }));
    },
  };
}
export type Messaging = ReturnType<typeof createMessaging>;

/** WP-009 calls this freshly at enqueue and immediately before generic delivery.
 * No messaging lock here: WP-009 holds its recipient lock, and messaging send
 * takes messaging then recipient locks. This read-only snapshot avoids inversion.
 * Native message reads/sends still use the linearizable messaging transaction.
 */
export function createMessageNoticeAuthorization(client: DatabaseClient) {
  return async (identity: MessagingIdentity, recipientId: string, conversationId: string): Promise<boolean> => {
    if (![identity.orgId, identity.userId, recipientId, conversationId].every(value => uuid.test(value)) || identity.userId === recipientId) return false;
    try {
      return await withOrg(client, identity.orgId, async sql => {
        const role = (await sql<{ unsafe: boolean }[]>`select r.rolsuper or r.rolbypassrls or
          exists(select 1 from pg_class c where c.relname = 'messaging_messages' and c.relowner = r.oid) as unsafe
          from pg_roles r where r.rolname = current_user`)[0];
        if (role?.unsafe !== false) return false;
        await sql`select set_config('app.current_user_id', ${identity.userId}, true)`;
        const rows = await sql`select c.id from messaging_conversations c
          join users sender on sender.org_id = c.org_id and sender.id = ${identity.userId} and sender.account_state = 'active'
          join users recipient on recipient.org_id = c.org_id and recipient.id = ${recipientId} and recipient.account_state = 'active'
          where c.org_id = ${identity.orgId} and c.id = ${conversationId}
          and ${identity.userId} in (c.participant_a, c.participant_b) and ${recipientId} in (c.participant_a, c.participant_b)
          and not exists(select 1 from blocks b where b.org_id = c.org_id and
            ((b.blocker_id = c.participant_a and b.blocked_id = c.participant_b) or (b.blocker_id = c.participant_b and b.blocked_id = c.participant_a)))`;
        return rows.length === 1;
      });
    } catch { return false; }
  };
}
