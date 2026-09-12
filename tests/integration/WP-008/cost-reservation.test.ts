import { describe, expect, it } from 'vitest';
import { AmbiguousProviderTimeoutError, DefaultAiGateway, FixedWindowRateLimiter, InMemoryExactCache, InMemoryReservationStore, PossiblyBilledProviderError, StaticPriceBook } from '../../../packages/ai/src/index.ts';
import type { AiProviderAdapter, EventDraft, GatewayOptions } from '../../../packages/ai/src/index.ts';

const context = { orgId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222', userRole: 'senior' as const, locale: 'en' as const, requestId: 'cost-test' };
const capabilities = { tools: true, structuredOutputs: true, streaming: false, embeddings: false, batch: false, promptCaching: false, maxConcurrency: 1, timeoutMs: 10, samplingSchema: 'anthropic-haiku-4-5' as const, acceptsTemperature: true, acceptsThinkingBudget: false, sdkRetriesDisabled: true as const };
function gatewayOptions(provider: AiProviderAdapter, store: InMemoryReservationStore, events: EventDraft[]): GatewayOptions { return { flags: { effective: async key => key !== 'ai.cache.exact_match' }, events: { append: async event => { events.push(event); return { id: `event-${events.length}` }; } }, prompts: { get: async feature => ({ ref: { feature, version: 'v1', hash: 'hash' }, text: 'prompt' }) }, router: { route: () => ({ provider: provider.id, model: 'claude-haiku-4-5', maxOutputTokens: 100 }) }, providers: new Map([[provider.id, provider]]), rateLimiter: new FixedWindowRateLimiter(), reservations: store, cache: new InMemoryExactCache(), cacheBoundary: { describe: async () => ({ cacheable: false, sourceContentVersionSet: [] }), reauthorize: async () => false }, prices: new StaticPriceBook({ 'anthropic-api:claude-haiku-4-5': { inputPerMillionUsd: 1, outputPerMillionUsd: 5, cachedPerMillionUsd: 0 } }) }; }

describe('transactional reservation behavior', () => {
  it('serializes concurrent reservations against one cap', async () => {
    const store = new InMemoryReservationStore(1);
    const make = (requestId: string) => store.reserve({ orgId: 'o', feature: 'concierge', requestId, reservedUsd: 0.75, maxOutputTokens: 10 });
    const results = await Promise.allSettled([make('a'), make('b')]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1); expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
  });
  it('keeps an ambiguous reservation pending at its upper bound', async () => {
    const store = new InMemoryReservationStore(1); const reservation = await store.reserve({ orgId: 'o', feature: 'concierge', requestId: 'a', reservedUsd: 0.75, maxOutputTokens: 10 }); await store.pending('o', reservation.id);
    expect(store.reservations.get(reservation.id)).toMatchObject({ state: 'pending_reconciliation', reservedUsd: 0.75, settledUsd: null });
  });
  it('never reports unknown timeout usage or cost as zero', async () => {
    const store = new InMemoryReservationStore(1); const events: EventDraft[] = [];
    const provider: AiProviderAdapter = { id: 'anthropic-api', capabilities, complete: () => Promise.reject(new AmbiguousProviderTimeoutError()) };
    const gateway = new DefaultAiGateway({ ...gatewayOptions(provider, store, events), maxGatewayRetries: 0 });
    const result = await gateway.chat({ feature: 'concierge', context, messages: [{ role: 'user', content: 'hello' }] });
    expect(result.outcome).toBe('error'); expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ usageKnown: false, tokensIn: null, tokensOut: null, settledUsd: null }); expect(events[0]?.costUsd).toBeGreaterThan(0);
    expect([...store.reservations.values()][0]?.state).toBe('pending_reconciliation');
  });
  it('keeps the whole envelope unknown when an uncertain send later succeeds', async () => {
    const store = new InMemoryReservationStore(1); const events: EventDraft[] = []; let sends = 0;
    const provider: AiProviderAdapter = { id: 'anthropic-api', capabilities, complete: () => { sends += 1; return sends === 1 ? Promise.reject(new PossiblyBilledProviderError()) : Promise.resolve({ text: 'ok', toolCalls: [], usage: { tokensIn: 2, tokensOut: 1, tokensCached: 0 }, model: 'claude-haiku-4-5', latencyMs: 2 }); } };
    const result = await new DefaultAiGateway(gatewayOptions(provider, store, events)).chat({ feature: 'concierge', context, messages: [{ role: 'user', content: 'hello' }] });
    const reservation = [...store.reservations.values()][0]; expect(result.outcome).toBe('ok'); expect(sends).toBe(2); expect(events[0]).toMatchObject({ usageKnown: false, tokensIn: null, tokensOut: null, costUsd: reservation?.reservedUsd }); expect(reservation?.state).toBe('settled');
  });
  it('enforces eight org-wide in-flight reservations and reconciles pending state', async () => {
    const store = new InMemoryReservationStore(100, 100, 8); const reservations = await Promise.all(Array.from({ length: 8 }, (_, index) => store.reserve({ orgId: 'o', feature: index % 2 ? 'concierge' : 'summaries', requestId: `${index}`, reservedUsd: 1, maxOutputTokens: 10 })));
    await expect(store.reserve({ orgId: 'o', feature: 'triage', requestId: 'ninth', reservedUsd: 1, maxOutputTokens: 10 })).rejects.toThrow(/concurrency/);
    await store.pending('o', reservations[0]!.id); await store.reconcile('o', reservations[0]!.id, null); expect(store.reservations.get(reservations[0]!.id)).toMatchObject({ state: 'expired', settledUsd: 1 });
  });
  it('does not resend a billed request when settlement fails', async () => {
    class FailingSettlementStore extends InMemoryReservationStore { override settle(): Promise<void> { return Promise.reject(new Error('settlement down')); } }
    const store = new FailingSettlementStore(1); const events: EventDraft[] = []; let sends = 0;
    const provider: AiProviderAdapter = { id: 'anthropic-api', capabilities, complete: () => { sends += 1; return Promise.resolve({ text: 'ok', toolCalls: [], usage: { tokensIn: 1, tokensOut: 1, tokensCached: 0 }, model: 'claude-haiku-4-5', latencyMs: 1 }); } };
    await expect(new DefaultAiGateway(gatewayOptions(provider, store, events)).chat({ feature: 'concierge', context, messages: [{ role: 'user', content: 'hello' }] })).rejects.toThrow(/settlement down/);
    expect(sends).toBe(1); expect(events).toHaveLength(0);
  });
  it('fails closed when reported usage exceeds the reserved envelope', async () => {
    const store = new InMemoryReservationStore(100); const events: EventDraft[] = [];
    const provider: AiProviderAdapter = { id: 'anthropic-api', capabilities, complete: () => Promise.resolve({ text: 'too costly', toolCalls: [], usage: { tokensIn: 1_000_000, tokensOut: 1_000_000, tokensCached: 0 }, model: 'claude-haiku-4-5', latencyMs: 1 }) };
    const result = await new DefaultAiGateway({ ...gatewayOptions(provider, store, events), maxGatewayRetries: 0 }).chat({ feature: 'concierge', context, messages: [{ role: 'user', content: 'hello' }] });
    expect(result).toMatchObject({ outcome: 'error', reason: 'COST_RESERVATION_EXCEEDED' }); expect(events[0]?.reason).toBe('COST_RESERVATION_EXCEEDED');
  });
  it('applies reservation, deadline and result-kill lifecycle to embeddings', async () => {
    const store = new InMemoryReservationStore(1); const events: EventDraft[] = []; let masterReads = 0; let sends = 0;
    const provider: AiProviderAdapter = { id: 'anthropic-api', capabilities: { ...capabilities, embeddings: true }, complete: () => Promise.reject(new Error('unused')), embed: () => { sends += 1; return Promise.resolve({ vectors: [[1, 2]], dimensions: 2, model: 'claude-haiku-4-5', usage: { tokensIn: 2, tokensOut: 0, tokensCached: 0 } }); } };
    const options = gatewayOptions(provider, store, events); options.flags = { effective: async key => key === 'ai.master' ? ++masterReads < 3 : true };
    const result = await new DefaultAiGateway(options).embed({ feature: 'event_rerank', context, inputs: ['🙂'] });
    expect(result).toMatchObject({ outcome: 'killed', vectors: [], humanRoute: '/events' }); expect(sends).toBe(1); expect([...store.reservations.values()][0]?.state).toBe('settled'); expect(events[0]).toMatchObject({ outcome: 'killed', promptVersion: null });
  });
});
