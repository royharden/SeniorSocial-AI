import { randomUUID } from 'node:crypto';
import type { AiContext, AiFeature, AiProviderId, AiProviderUsage, CacheKey, CostReservation } from './types.ts';
import type { CacheValue, ExactCache, PriceBook, RateLimitDecision, RateLimiter, ReservationStore } from './ports.ts';

export class InMemoryExactCache implements ExactCache {
  private readonly values = new Map<string, CacheValue>();
  private key(key: CacheKey) { return JSON.stringify({ ...key, sourceContentVersionSet: [...key.sourceContentVersionSet].sort() }); }
  get(key: CacheKey) { const value = this.values.get(this.key(key)) ?? null; return Promise.resolve(value && Date.parse(value.expiresAt) > Date.now() ? value : null); }
  put(key: CacheKey, value: CacheValue) { this.values.set(this.key(key), value); return Promise.resolve(); }
  invalidate(predicate: (key: CacheKey) => boolean) { let count = 0; for (const [encoded] of this.values) { const key = JSON.parse(encoded) as CacheKey; if (predicate(key)) { this.values.delete(encoded); count += 1; } } return Promise.resolve(count); }
}

export class FixedWindowRateLimiter implements RateLimiter {
  private readonly users = new Map<string, number[]>(); private readonly features = new Map<string, number[]>();
  constructor(private readonly userLimit = 20, private readonly featureLimit = 200, private readonly windowMs = 60_000, private readonly now = () => Date.now()) {}
  consume(context: AiContext, feature: AiFeature): Promise<RateLimitDecision> {
    const now = this.now(); const cutoff = now - this.windowMs; const userKey = `${context.orgId}:${context.userId}:${feature}`; const featureKey = `${context.orgId}:${feature}`;
    const user = (this.users.get(userKey) ?? []).filter(at => at > cutoff); const all = (this.features.get(featureKey) ?? []).filter(at => at > cutoff);
    const allowed = user.length < this.userLimit && all.length < this.featureLimit;
    if (allowed) { user.push(now); all.push(now); this.users.set(userKey, user); this.features.set(featureKey, all); }
    const oldest = Math.min(user[0] ?? now, all[0] ?? now);
    return Promise.resolve({ allowed, retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000)), userRemaining: Math.max(0, this.userLimit - user.length), featureRemaining: Math.max(0, this.featureLimit - all.length) });
  }
}

export class InMemoryReservationStore implements ReservationStore {
  readonly reservations = new Map<string, CostReservation>(); private queue: Promise<void> = Promise.resolve();
  constructor(private readonly orgCapUsd = Number.POSITIVE_INFINITY, private readonly featureCapUsd = Number.POSITIVE_INFINITY, private readonly maxInFlight = 8) {}
  private exclusive<T>(work: () => T | Promise<T>): Promise<T> { const result = this.queue.then(work, work); this.queue = result.then(() => undefined, () => undefined); return result; }
  async reserve(input: { orgId: string; feature: AiFeature; requestId: string; reservedUsd: number; maxOutputTokens: number }): Promise<CostReservation> { return this.exclusive(() => { const open = [...this.reservations.values()].filter(item => item.orgId === input.orgId && ['held','pending_reconciliation'].includes(item.state)); const held = open.reduce((sum, item) => sum + item.reservedUsd, 0); const featureHeld = open.filter(item => item.feature === input.feature).reduce((sum, item) => sum + item.reservedUsd, 0); if (open.length >= this.maxInFlight) throw new Error('AI concurrency cap exceeded'); if (held + input.reservedUsd > this.orgCapUsd || featureHeld + input.reservedUsd > this.featureCapUsd) throw new Error('AI cost cap exceeded'); const item: CostReservation = { id: randomUUID(), ...input, state: 'held', createdAt: new Date().toISOString(), closedAt: null, settledUsd: null, attempts: [] }; this.reservations.set(item.id, item); return item; }); }
  async addAttempt(orgId: string, id: string, kind: CostReservation['attempts'][number]['kind'], model: string, usage: AiProviderUsage | null) { await this.exclusive(() => { const item = this.required(orgId, id); this.reservations.set(id, { ...item, attempts: [...item.attempts, { kind, model, startedAt: new Date().toISOString(), usage }] }); }); }
  async settle(orgId: string, id: string, settledUsd: number) { await this.close(orgId, id, 'settled', settledUsd); }
  async release(orgId: string, id: string) { await this.close(orgId, id, 'released', 0); }
  async pending(orgId: string, id: string) { await this.exclusive(() => { const item = this.required(orgId, id); if (item.state !== 'held') throw new Error('reservation cannot become pending'); this.reservations.set(id, { ...item, state: 'pending_reconciliation' }); }); }
  async reconcile(orgId: string, id: string, settledUsd: number | null) { await this.exclusive(() => { const item = this.required(orgId, id); if (item.state !== 'pending_reconciliation') throw new Error('reservation is not pending reconciliation'); this.reservations.set(id, { ...item, state: settledUsd === null ? 'expired' : 'settled', settledUsd: settledUsd ?? item.reservedUsd, closedAt: new Date().toISOString() }); }); }
  private async close(orgId: string, id: string, state: 'settled' | 'released', settledUsd: number) { await this.exclusive(() => { const item = this.required(orgId, id); if (item.state === state) return; if (item.state !== 'held') throw new Error('reservation cannot be closed from current state'); this.reservations.set(id, { ...item, state, settledUsd, closedAt: new Date().toISOString() }); }); }
  private required(orgId: string, id: string) { const item = this.reservations.get(id); if (!item || item.orgId !== orgId) throw new Error('unknown tenant reservation'); return item; }
}

export class StaticPriceBook implements PriceBook {
  constructor(private readonly prices: Readonly<Record<string, { inputPerMillionUsd: number; outputPerMillionUsd: number; cachedPerMillionUsd: number }>>) {}
  cost(provider: AiProviderId, model: string, usage: AiProviderUsage) { const price = this.prices[`${provider}:${model}`]; if (!price) throw new Error(`missing price for ${provider}:${model}`); return (usage.tokensIn * price.inputPerMillionUsd + usage.tokensOut * price.outputPerMillionUsd + usage.tokensCached * price.cachedPerMillionUsd) / 1_000_000; }
  upperBound(provider: AiProviderId, model: string, serializedBytes: number, maxOutputTokens: number, attempts: number) { return this.cost(provider, model, { tokensIn: Math.max(1, serializedBytes) * attempts, tokensOut: maxOutputTokens * attempts, tokensCached: 0 }); }
}
