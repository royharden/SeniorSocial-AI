import type { DatabaseClient, TenantTransaction } from '@seniorsocial/db';
import type { AssistanceRequestRecord, ConciergeAnswer } from './types.ts';
import type { ConversationStore, StoredConversation } from './core.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface ConversationRow {
  readonly id: string;
  readonly org_id: string;
  readonly user_id: string;
  readonly handoff_key: string;
  readonly turns: ConciergeAnswer[];
  readonly ai_enabled: boolean;
  readonly last_question: string;
  readonly handoff: AssistanceRequestRecord | null;
}

interface ObservedConversation {
  readonly turnCount: number;
  readonly orgId: string;
  readonly userId: string;
}

/** PostgreSQL-backed concierge continuity, scoped to the authenticated resident by RLS. */
export class PostgresConversationStore implements ConversationStore {
  private readonly observed = new WeakMap<StoredConversation, ObservedConversation>();

  constructor(private readonly client: () => DatabaseClient) {}

  async create(value: StoredConversation, orgId?: string, userId?: string): Promise<void> {
    if (!matchesIdentity(value, orgId, userId)) throw new Error('trusted concierge identity is required');
    await this.transaction(value.orgId, value.userId, async sql => {
      await sql`
        insert into concierge_conversations
          (id, org_id, user_id, handoff_key, turns, ai_enabled, last_question, handoff)
        values
          (${value.id}, ${value.orgId}, ${value.userId}, ${value.handoffKey},
           ${sql.json(asJson(value.turns))}, ${value.aiEnabled}, ${value.lastQuestion},
           ${value.handoff ? sql.json(asJson(value.handoff)) : null})
      `;
    });
  }

  async get(id: string, orgId?: string, userId?: string): Promise<StoredConversation | null> {
    if (!UUID.test(id) || typeof orgId !== 'string' || !UUID.test(orgId)
      || typeof userId !== 'string' || !UUID.test(userId)) return null;
    return this.transaction(orgId, userId, async sql => {
      const rows = await this.find(sql, id, orgId, userId);
      return rows[0] ? this.hydrate(rows[0]) : null;
    });
  }

  async save(value: StoredConversation, orgId?: string, userId?: string): Promise<void> {
    if (!matchesIdentity(value, orgId, userId)) throw new Error('trusted concierge identity is required');
    const baseline = this.observed.get(value);
    if (!baseline || baseline.orgId !== orgId || baseline.userId !== userId) {
      throw new Error('conversation must be loaded through the authenticated store before save');
    }
    const appended = value.turns.slice(baseline.turnCount);
    await this.transaction(orgId, userId, async sql => {
      await sql`
        update concierge_conversations
        set turns = turns || ${sql.json(asJson(appended))}::jsonb,
            ai_enabled = ai_enabled and ${value.aiEnabled},
            last_question = ${value.lastQuestion},
            revision = revision + 1,
            updated_at = statement_timestamp()
        where id = ${value.id} and org_id = ${orgId} and user_id = ${userId}
      `;
    });
    this.observed.set(value, { turnCount: value.turns.length, orgId, userId });
  }

  async getOrCreateHandoff(
    id: string,
    orgId: string,
    userId: string,
    create: (conversation: Readonly<StoredConversation>) => Promise<AssistanceRequestRecord>,
  ): Promise<AssistanceRequestRecord | null> {
    if (!validIdentity(id, orgId, userId)) return null;
    return this.transaction(orgId, userId, async sql => {
      const rows = await this.find(sql, id, orgId, userId, true);
      const row = rows[0];
      if (!row) return null;
      if (row.handoff) return structuredClone(row.handoff);
      const result = await create(this.hydrate(row));
      if (result.org_id !== orgId) throw new Error('assistance port returned a cross-tenant record');
      const persisted = await sql<{ handoff: AssistanceRequestRecord }[]>`
        update concierge_conversations
        set handoff = ${sql.json(asJson(result))}, revision = revision + 1, updated_at = statement_timestamp()
        where id = ${id} and org_id = ${orgId} and user_id = ${userId} and handoff is null
        returning handoff
      `;
      const handoff = persisted[0]?.handoff;
      if (!handoff) throw new Error('durable concierge handoff persistence failed');
      return structuredClone(handoff);
    });
  }

  private async transaction<T>(orgId: string, userId: string, work: (sql: TenantTransaction) => Promise<T>): Promise<T> {
    const sql = await this.client().reserve();
    try {
      await sql`begin`;
      await sql`select set_config('app.current_org_id', ${orgId}, true)`;
      await sql`select set_config('app.current_user_id', ${userId}, true)`;
      const result = await work(sql);
      await sql`commit`;
      return result;
    } catch (error) {
      await sql`rollback`;
      throw error;
    } finally {
      sql.release();
    }
  }

  private find(
    sql: TenantTransaction,
    id: string,
    orgId: string,
    userId: string,
    lock = false,
  ): Promise<ConversationRow[]> {
    return sql<ConversationRow[]>`
      select id, org_id, user_id, handoff_key, turns, ai_enabled, last_question, handoff
      from concierge_conversations
      where id = ${id} and org_id = ${orgId} and user_id = ${userId}
      limit 1
      ${lock ? sql`for update` : sql``}
    `;
  }

  private hydrate(row: ConversationRow): StoredConversation {
    const value: StoredConversation = {
      id: row.id,
      orgId: row.org_id,
      userId: row.user_id,
      handoffKey: row.handoff_key,
      turns: structuredClone(row.turns),
      aiEnabled: row.ai_enabled,
      lastQuestion: row.last_question,
      ...(row.handoff ? { handoff: structuredClone(row.handoff) } : {}),
    };
    this.observed.set(value, { turnCount: value.turns.length, orgId: value.orgId, userId: value.userId });
    return value;
  }
}

function validIdentity(id: string, orgId?: string, userId?: string): boolean {
  return UUID.test(id) && typeof orgId === 'string' && UUID.test(orgId)
    && typeof userId === 'string' && UUID.test(userId);
}

function matchesIdentity(value: StoredConversation, orgId?: string, userId?: string): boolean {
  return validIdentity(value.id, orgId, userId) && value.orgId === orgId && value.userId === userId;
}

function asJson(value: unknown): Parameters<TenantTransaction['json']>[0] {
  return JSON.parse(JSON.stringify(value)) as Parameters<TenantTransaction['json']>[0];
}
