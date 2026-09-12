import type { DatabaseClient } from '@seniorsocial/db';
import { withOrg } from '@seniorsocial/db';
import type { AiContext, AiFeature, AiProviderUsage, CostReservation } from './types.ts';
import type { RateLimitDecision, RateLimiter, ReservationStore } from './ports.ts';

interface ReservationRow { id: string; org_id: string; feature: CostReservation['feature']; request_id: string; reserved_usd: number; max_output_tokens: number; state: CostReservation['state']; created_at: string; closed_at: string | null; settled_usd: number | null }
export class DurableReservationStore implements ReservationStore {
  constructor(private readonly client: DatabaseClient) {}
  async reserve(input: { orgId: string; feature: CostReservation['feature']; requestId: string; reservedUsd: number; maxOutputTokens: number }): Promise<CostReservation> {
    return withOrg(this.client, input.orgId, async transaction => {
      const rows = await transaction<ReservationRow[]>`select * from reserve_ai_cost(${input.orgId}, ${input.feature}, ${input.requestId}, ${input.reservedUsd}, ${input.maxOutputTokens})`;
      return this.map(rows[0]);
    });
  }
  async addAttempt(orgId: string, id: string, kind: CostReservation['attempts'][number]['kind'], model: string, usage: AiProviderUsage | null) { await withOrg(this.client, orgId, async transaction => { const rows = await transaction<{ id: string }[]>`insert into ai_cost_attempts (reservation_id, org_id, kind, model, tokens_in, tokens_out, tokens_cached) select ${id}, ${orgId}, ${kind}, ${model}, ${usage?.tokensIn ?? null}, ${usage?.tokensOut ?? null}, ${usage?.tokensCached ?? null} where exists (select 1 from ai_cost_reservations where org_id=${orgId} and id=${id}) returning id`; if (!rows[0]) throw new Error('unknown tenant reservation'); }); }
  async settle(orgId: string, id: string, settledUsd: number) { await this.transition(orgId, id, 'settled', settledUsd); }
  async release(orgId: string, id: string) { await this.transition(orgId, id, 'released', 0); }
  async pending(orgId: string, id: string) { await this.transition(orgId, id, 'pending_reconciliation', null); }
  async reconcile(orgId: string, id: string, settledUsd: number | null) { await this.transition(orgId, id, settledUsd === null ? 'expired' : 'settled', settledUsd); }
  private async transition(orgId: string, id: string, state: CostReservation['state'], settledUsd: number | null) { await withOrg(this.client, orgId, async transaction => { await transaction`select transition_ai_cost(${orgId}, ${id}, ${state}, ${settledUsd})`; }); }
  private map(row: ReservationRow | undefined): CostReservation { if (!row) throw new Error('reservation insert returned no row'); return { id: row.id, orgId: row.org_id, feature: row.feature, requestId: row.request_id, reservedUsd: Number(row.reserved_usd), maxOutputTokens: row.max_output_tokens, state: row.state, createdAt: row.created_at, closedAt: row.closed_at, settledUsd: row.settled_usd === null ? null : Number(row.settled_usd), attempts: [] }; }
}

export class DurableRateLimiter implements RateLimiter {
  constructor(private readonly client: DatabaseClient, private readonly userLimit: number, private readonly featureLimit: number, private readonly windowSeconds = 60) {}
  async consume(context: AiContext, feature: AiFeature): Promise<RateLimitDecision> {
    return withOrg(this.client, context.orgId, async transaction => {
      const rows = await transaction<{ allowed: boolean; retry_after_seconds: number; user_remaining: number; feature_remaining: number }[]>`
        select * from consume_ai_rate_limit(${context.orgId}, ${context.userId}, ${feature}, ${this.userLimit}, ${this.featureLimit}, ${this.windowSeconds})
      `;
      const row = rows[0]; if (!row) throw new Error('rate limiter returned no decision');
      return { allowed: row.allowed, retryAfterSeconds: row.retry_after_seconds, userRemaining: row.user_remaining, featureRemaining: row.feature_remaining };
    });
  }
}
