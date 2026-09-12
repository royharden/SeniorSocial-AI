import type { AiContext, AiEvent, AiFeature, AiProviderId, AiProviderUsage, CacheKey, CostReservation, PromptRef } from './types.ts';

export type EventDraft = Omit<AiEvent, 'id' | 'createdAt' | 'tokensIn' | 'tokensOut' | 'tokensCached'> & { tokensIn: number | null; tokensOut: number | null; tokensCached: number | null };
export interface AiEventWriter { append(event: EventDraft): Promise<{ id: string }> }
export interface FlagReader { effective(flag: `ai.${AiFeature}` | 'ai.master' | 'ai.cache.exact_match', orgId: string): Promise<boolean> }
export interface Prompt { ref: PromptRef; text: string }
export interface PromptRegistry { get(feature: AiFeature): Promise<Prompt> }
export interface Route { provider: AiProviderId; model: string; maxOutputTokens: number }
export interface Router { route(feature: AiFeature): Route }
export interface RateLimitDecision { allowed: boolean; retryAfterSeconds: number; userRemaining: number; featureRemaining: number }
export interface RateLimiter { consume(context: AiContext, feature: AiFeature): Promise<RateLimitDecision> }
export interface ReservationStore {
  reserve(input: { orgId: string; feature: AiFeature; requestId: string; reservedUsd: number; maxOutputTokens: number }): Promise<CostReservation>;
  addAttempt(orgId: string, id: string, kind: CostReservation['attempts'][number]['kind'], model: string, usage: AiProviderUsage | null): Promise<void>;
  settle(orgId: string, id: string, settledUsd: number): Promise<void>;
  release(orgId: string, id: string): Promise<void>;
  pending(orgId: string, id: string): Promise<void>;
  reconcile(orgId: string, id: string, settledUsd: number | null): Promise<void>;
}
export interface CacheValue { response: unknown; expiresAt: string }
export interface ExactCache { get(key: CacheKey): Promise<CacheValue | null>; put(key: CacheKey, value: CacheValue): Promise<void>; invalidate(predicate: (key: CacheKey) => boolean): Promise<number> }
export interface CacheBoundary { describe(context: AiContext, feature: AiFeature): Promise<{ cacheable: boolean; sourceContentVersionSet: readonly string[] }>; reauthorize(context: AiContext, key: CacheKey): Promise<boolean> }
export interface PriceBook { cost(provider: AiProviderId, model: string, usage: AiProviderUsage): number; upperBound(provider: AiProviderId, model: string, serializedBytes: number, maxOutputTokens: number, attempts: number): number }
