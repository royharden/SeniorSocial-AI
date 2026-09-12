import type { DatabaseClient, TenantTransaction } from '@seniorsocial/db';
import { withOrg } from '@seniorsocial/db';

export const auditActions = [
  'auth.signed_in', 'auth.signed_out', 'auth.code_requested', 'auth.demo_code_used',
  'consent.granted', 'consent.revoked', 'consent.read_back_confirmed',
  'caregiver.invited', 'caregiver.accepted', 'caregiver.acted', 'caregiver.denied',
  'ride.created', 'ride.transitioned', 'ride.send_failed', 'assistance.opened',
  'assistance.owned', 'assistance.transitioned', 'assistance.sla_breached',
  'moderation.flagged', 'moderation.decided', 'content.updated', 'service.updated',
  'partner.updated', 'translation.approved', 'translation.invalidated',
  'user.role_changed', 'user.held_for_review', 'flag.changed', 'export.created',
  'export.downloaded', 'ai.recommended', 'ai.refused', 'ai.killed',
  'notification.preferences_changed', 'notification.queued', 'notification.attempted', 'notification.suppressed',
] as const;
export type AuditAction = (typeof auditActions)[number];
export type AuditOutcome = 'allowed' | 'denied' | 'error';

export interface AuditEvent {
  id: string; actor: string; on_behalf_of: string | null; action: AuditAction;
  target: string; org_id: string; at: string; outcome: AuditOutcome; reason: string | null;
  fields: string[]; prompt_version: string | null; ai_event_id: string | null; request_id: string | null; ip_hash: string | null;
}
export interface AuditIntent {
  actor: string; on_behalf_of?: string | null; action: AuditAction; target: string; org_id: string;
  outcome: AuditOutcome; reason?: string | null; fields?: readonly string[]; prompt_version?: string | null;
  ai_event_id?: string | null; request_id?: string | null; ip_hash?: string | null;
}
/** Narrow ingestion boundary for packages that own audited state changes. */
export interface AuditSink { emit(intent: AuditIntent): Promise<void> }
export interface PageMeta { next_cursor: string | null; total_known: boolean }
export interface AuditPage { items: AuditEvent[]; meta: PageMeta }

const actionSet = new Set<string>(auditActions);
const actorPattern = /^(?:user:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|system:[a-z0-9_-]+|ai:[a-z0-9_]+)$/iu;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const targetPattern = /^[a-z][a-z0-9_]*:[A-Za-z0-9._-]+$/u;

function cleanReason(reason: string | null | undefined, required: boolean): string | null {
  const value = reason?.trim() || null;
  if (required && !value) throw new Error('reason is required');
  if (value && (value.length > 500 || /[\r\n]/u.test(value))) throw new Error('reason must be one line of at most 500 characters');
  return value;
}

function cleanFields(fields: readonly string[] | undefined): string[] {
  const value = [...(fields ?? [])];
  if (value.length > 64) throw new Error('audit fields must contain at most 64 names');
  if (value.some(field => !/^[a-z][a-z0-9_]{0,63}$/u.test(field))) throw new Error('invalid audit field name');
  if (new Set(value).size !== value.length) throw new Error('audit fields must be unique');
  return value.sort();
}

export function validateAuditInput(input: AuditIntent): void {
  if (!actionSet.has(input.action)) throw new Error('unknown audit action');
  if (!actorPattern.test(input.actor)) throw new Error('invalid audit actor');
  if (!uuidPattern.test(input.org_id)) throw new Error('invalid audit org_id');
  if (input.on_behalf_of && !/^user:[0-9a-f-]{36}$/iu.test(input.on_behalf_of)) throw new Error('invalid on_behalf_of');
  if (input.ai_event_id && !uuidPattern.test(input.ai_event_id)) throw new Error('invalid ai_event_id');
  if (!targetPattern.test(input.target)) throw new Error('invalid audit target');
  cleanReason(input.reason, input.outcome !== 'allowed' || input.action === 'flag.changed' || input.action === 'moderation.decided');
  cleanFields(input.fields);
}

export async function appendAudit(transaction: TenantTransaction, input: AuditIntent): Promise<AuditEvent> {
  validateAuditInput(input);
  const reason = cleanReason(input.reason, input.outcome !== 'allowed' || input.action === 'flag.changed' || input.action === 'moderation.decided');
  const fields = cleanFields(input.fields);
  const rows = await transaction<AuditEvent[]>`
    insert into audit_events (actor, on_behalf_of, action, target, org_id, outcome, reason, fields, prompt_version, ai_event_id, request_id, ip_hash)
    values (${input.actor}, ${input.on_behalf_of ?? null}, ${input.action}, ${input.target}, ${input.org_id}, ${input.outcome}, ${reason}, ${fields}, ${input.prompt_version ?? null}, ${input.ai_event_id ?? null}, ${input.request_id ?? null}, ${input.ip_hash ?? null})
    returning id, actor, on_behalf_of, action, target, org_id, at::text, outcome, reason, fields, prompt_version, ai_event_id, request_id, ip_hash
  `;
  const event = rows[0];
  if (!event) throw new Error('audit insert did not return a row');
  return event;
}

function boundedLimit(limit: number | undefined): number {
  const value = limit ?? 50;
  if (!Number.isInteger(value) || value < 1 || value > 100) throw new Error('limit must be an integer from 1 to 100');
  return value;
}
function parseCursor(cursor: string | undefined): { at: string; id: string } | null {
  if (!cursor) return null;
  const separator = cursor.lastIndexOf('|');
  const at = cursor.slice(0, separator);
  const id = cursor.slice(separator + 1);
  if (separator < 1 || Number.isNaN(Date.parse(at)) || !/^[0-9a-f-]{36}$/iu.test(id)) throw new Error('invalid cursor');
  return { at, id };
}
function nextCursor(at: string, id: string): string { return `${at}|${id}`; }

export class AuditRepository {
  constructor(private readonly client: DatabaseClient) {}

  async list(orgId: string, query: { action?: string; target?: string; cursor?: string; limit?: number } = {}): Promise<AuditPage> {
    const limit = boundedLimit(query.limit);
    const cursor = parseCursor(query.cursor);
    return withOrg(this.client, orgId, async transaction => {
      const rows = await transaction<AuditEvent[]>`
        select id, actor, on_behalf_of, action, target, org_id, at::text, outcome, reason, fields, prompt_version, ai_event_id, request_id, ip_hash
        from audit_events
        where org_id = ${orgId}
          and (${query.action ?? null}::text is null or action = ${query.action ?? null})
          and (${query.target ?? null}::text is null or target = ${query.target ?? null})
          and (${cursor?.at ?? null}::timestamptz is null or (at, id) < (${cursor?.at ?? null}::timestamptz, ${cursor?.id ?? null}::uuid))
        order by at desc, id desc limit ${limit + 1}
      `;
      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit);
      const last = items.at(-1);
      return { items, meta: { next_cursor: hasMore && last ? nextCursor(last.at, last.id) : null, total_known: true } };
    });
  }
}

export class DurableAuditSink implements AuditSink {
  constructor(private readonly client: DatabaseClient) {}
  async emit(intent: AuditIntent): Promise<void> {
    await withOrg(this.client, intent.org_id, async transaction => { await appendAudit(transaction, intent); });
  }
}

export type AiOutcome = 'ok' | 'refused' | 'error' | 'killed' | 'egress_blocked';
export interface AiEventInput {
  id?: string; orgId: string; requestId: string; feature: string; promptVersion: string | null; promptHash: string | null;
  provider: string; model: string; tokensIn: number | null; tokensOut: number | null; tokensCached: number | null;
  latencyMs: number; cacheHit: boolean; userRole: string; onBehalfOf: string | null; outcome: AiOutcome;
  reason: string | null; costUsd: number; reservationId: string | null; settledUsd: number | null; usageKnown: boolean;
}
export interface AiEventRow {
  id: string; org_id: string; request_id: string; feature: string; prompt_version: string | null; prompt_hash: string | null;
  provider: string; model: string; tokens_in: number | null; tokens_out: number | null; tokens_cached: number | null;
  latency_ms: number; cache_hit: boolean; user_role: string; on_behalf_of: string | null; outcome: AiOutcome;
  reason: string | null; cost_usd: number; reservation_id: string | null; settled_usd: number | null; usage_known: boolean; created_at: string;
}
export interface AiEventPage { items: AiEventRow[]; meta: PageMeta }

export class AiEventRepository {
  constructor(private readonly client: DatabaseClient) {}
  async append(input: AiEventInput): Promise<AiEventRow> {
    return withOrg(this.client, input.orgId, async transaction => {
      const rows = await transaction<AiEventRow[]>`
        insert into ai_events (id, org_id, request_id, feature, prompt_version, prompt_hash, provider, model, tokens_in, tokens_out, tokens_cached, latency_ms, cache_hit, user_role, on_behalf_of, outcome, reason, cost_usd, reservation_id, settled_usd, usage_known)
        values (coalesce(${input.id ?? null}::uuid, uuid_generate_v4()), ${input.orgId}, ${input.requestId}, ${input.feature}, ${input.promptVersion}, ${input.promptHash}, ${input.provider}, ${input.model}, ${input.tokensIn}, ${input.tokensOut}, ${input.tokensCached}, ${input.latencyMs}, ${input.cacheHit}, ${input.userRole}, ${input.onBehalfOf}, ${input.outcome}, ${cleanReason(input.reason, ['refused','error','killed'].includes(input.outcome))}, ${input.costUsd}, ${input.reservationId}, ${input.settledUsd}, ${input.usageKnown})
        returning id, org_id, request_id, feature, prompt_version, prompt_hash, provider, model, tokens_in, tokens_out, tokens_cached, latency_ms, cache_hit, user_role, on_behalf_of, outcome, reason, cost_usd::float8 as cost_usd, reservation_id, settled_usd::float8 as settled_usd, usage_known, created_at::text
      `;
      const event = rows[0]; if (!event) throw new Error('AI event insert did not return a row'); return event;
    });
  }
  async list(orgId: string, query: { feature?: string; cursor?: string; limit?: number } = {}): Promise<AiEventPage> {
    const limit = boundedLimit(query.limit);
    const cursor = parseCursor(query.cursor);
    return withOrg(this.client, orgId, async transaction => {
      const rows = await transaction<AiEventRow[]>`
        select id, org_id, request_id, feature, prompt_version, prompt_hash, provider, model, tokens_in, tokens_out, tokens_cached, latency_ms, cache_hit, user_role, on_behalf_of, outcome, reason, cost_usd::float8 as cost_usd, reservation_id, settled_usd::float8 as settled_usd, usage_known, created_at::text
        from ai_events where org_id = ${orgId}
          and (${query.feature ?? null}::text is null or feature = ${query.feature ?? null})
          and (${cursor?.at ?? null}::timestamptz is null or (created_at, id) < (${cursor?.at ?? null}::timestamptz, ${cursor?.id ?? null}::uuid))
        order by created_at desc, id desc limit ${limit + 1}
      `;
      const hasMore = rows.length > limit; const items = rows.slice(0, limit);
      const last = items.at(-1);
      return { items, meta: { next_cursor: hasMore && last ? nextCursor(last.created_at, last.id) : null, total_known: true } };
    });
  }
}
