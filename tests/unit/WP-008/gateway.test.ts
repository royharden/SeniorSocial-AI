import { describe, expect, it } from 'vitest';
import { DefaultAiGateway, FixedWindowRateLimiter, InMemoryExactCache, InMemoryReservationStore, StaticPriceBook, StubProviderAdapter } from '../../../packages/ai/src/index.ts';
import type { AiProviderAdapter, EventDraft, GatewayOptions } from '../../../packages/ai/src/index.ts';

const context = { orgId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222', userRole: 'senior' as const, locale: 'en' as const, requestId: 'request-1' };
function fixture(flag = true, flags?: GatewayOptions['flags'], overrides: Partial<GatewayOptions> = {}) {
  const events: EventDraft[] = []; const stub = new StubProviderAdapter();
  const options: GatewayOptions = {
    flags: flags ?? { effective: async key => key === 'ai.cache.exact_match' || flag },
    events: { append: async event => { events.push(event); return { id: `event-${events.length}` }; } },
    prompts: { get: async feature => ({ ref: { feature, version: 'v1', hash: 'hash' }, text: 'safe prompt' }) },
    router: { route: () => ({ provider: 'stub', model: 'test-stub', maxOutputTokens: 100 }) }, providers: new Map([['stub', stub]]),
    rateLimiter: new FixedWindowRateLimiter(), reservations: new InMemoryReservationStore(), cache: new InMemoryExactCache(),
    cacheBoundary: { describe: async () => ({ cacheable: true, sourceContentVersionSet: ['directory:1:v1'] }), reauthorize: async () => true },
    prices: new StaticPriceBook({ 'stub:test-stub': { inputPerMillionUsd: 0, outputPerMillionUsd: 0, cachedPerMillionUsd: 0 } }),
    ...overrides,
  };
  return { gateway: new DefaultAiGateway(options), events };
}
describe('AiGateway', () => {
  it('writes exactly one complete event on a call and on its exact cache hit', async () => {
    const { gateway, events } = fixture(); const request = { feature: 'concierge' as const, context, messages: [{ role: 'user' as const, content: ' Where is lunch? ' }] };
    expect((await gateway.chat(request)).cacheHit).toBe(false); expect((await gateway.chat(request)).cacheHit).toBe(true);
    expect(events).toHaveLength(2); expect(events[1]).toMatchObject({ orgId: context.orgId, requestId: context.requestId, feature: 'concierge', promptVersion: 'v1', cacheHit: true, outcome: 'ok', costUsd: 0 });
  });
  it('kills before provider work while preserving the native human route', async () => {
    const { gateway, events } = fixture(false); const result = await gateway.chat({ feature: 'concierge', context, messages: [{ role: 'user', content: 'help' }] });
    expect(result).toMatchObject({ outcome: 'killed', humanRoute: '/assistance', cacheHit: false }); expect(events).toHaveLength(1); expect(events[0]?.promptVersion).toBeNull();
  });
  it('requires explicit tenant and user identity', async () => {
    const { gateway, events } = fixture(); await expect(gateway.chat({ feature: 'concierge', context: { ...context, userId: '' }, messages: [] })).rejects.toThrow(/explicit tenant/); expect(events).toHaveLength(0);
  });
  it('discards a provider result when the kill switch changes in flight', async () => {
    let masterReads = 0; const { gateway, events } = fixture(true, { effective: async key => key === 'ai.master' ? ++masterReads < 3 : key !== 'ai.cache.exact_match' });
    const result = await gateway.chat({ feature: 'concierge', context, messages: [{ role: 'user', content: 'help' }] });
    expect(result).toMatchObject({ outcome: 'killed', text: '', humanRoute: '/assistance' }); expect(events).toHaveLength(1); expect(events[0]?.promptVersion).toBeNull();
  });
  it('re-reads kill switches before retry and does not make the second send', async () => {
    const base = new StubProviderAdapter(); let sends = 0; let masterReads = 0; const provider: AiProviderAdapter = { ...base, complete: () => { sends += 1; return Promise.reject(new Error('definite local failure')); } };
    const flags = { effective: async (key: Parameters<GatewayOptions['flags']['effective']>[0]) => key === 'ai.master' ? ++masterReads < 3 : key !== 'ai.cache.exact_match' };
    const { gateway } = fixture(true, flags, { providers: new Map([['stub', provider]]) }); const result = await gateway.chat({ feature: 'concierge', context, messages: [{ role: 'user', content: 'help' }] });
    expect(result.outcome).toBe('killed'); expect(sends).toBe(1);
  });
  it('parses and validates structured classifier JSON without guessing a label', async () => {
    const base = new StubProviderAdapter(); let sends = 0; const provider: AiProviderAdapter = { ...base, complete: () => { sends += 1; return Promise.resolve({ text: '{"label":"safe","confidence":0.8}', toolCalls: [], usage: { tokensIn: 1, tokensOut: 1, tokensCached: 0 }, model: 'test-stub', latencyMs: 1 }); } };
    const { gateway, events } = fixture(true, undefined, { providers: new Map([['stub', provider]]) }); const result = await gateway.classify({ feature: 'moderation', context, input: 'hello', labels: ['safe','review'] as const });
    expect(result).toMatchObject({ outcome: 'ok', label: 'safe', confidence: 0.8 }); expect(sends).toBe(1); expect(events).toHaveLength(1);
  });
  it('fails malformed structured output locally without retrying transport', async () => {
    const base = new StubProviderAdapter(); let sends = 0; const provider: AiProviderAdapter = { ...base, complete: () => { sends += 1; return Promise.resolve({ text: 'not-json', toolCalls: [], usage: { tokensIn: 1, tokensOut: 1, tokensCached: 0 }, model: 'test-stub', latencyMs: 1 }); } };
    const { gateway, events } = fixture(true, undefined, { providers: new Map([['stub', provider]]) }); const result = await gateway.classify({ feature: 'moderation', context, input: 'hello', labels: ['safe','review'] as const });
    expect(result).toMatchObject({ outcome: 'error', confidence: 0 }); expect(sends).toBe(1); expect(events[0]?.reason).toBe('PROVIDER_STRUCTURED_OUTPUT_INVALID');
  });
  it('recognizes a structured refusal as a non-throwing human route', async () => {
    const base = new StubProviderAdapter(); const provider: AiProviderAdapter = { ...base, complete: () => Promise.resolve({ text: '', structured: { outcome: 'refused', humanRoute: '/report' }, toolCalls: [], usage: { tokensIn: 1, tokensOut: 1, tokensCached: 0 }, model: 'test-stub', latencyMs: 1 }) };
    const { gateway, events } = fixture(true, undefined, { providers: new Map([['stub', provider]]) }); const result = await gateway.chat({ feature: 'moderation', context, messages: [{ role: 'user', content: 'content' }] });
    expect(result).toMatchObject({ outcome: 'refused', humanRoute: '/report', reason: 'MODEL_REFUSAL' }); expect(events[0]?.outcome).toBe('refused');
  });
  it('never retries for cache or event finalization failures', async () => {
    const base = new StubProviderAdapter(); let sends = 0; const provider: AiProviderAdapter = { ...base, complete: input => { sends += 1; return base.complete(input); } };
    const cache = new InMemoryExactCache(); cache.put = () => Promise.reject(new Error('cache down'));
    const cached = fixture(true, undefined, { providers: new Map([['stub', provider]]), cache }); await cached.gateway.chat({ feature: 'concierge', context, messages: [{ role: 'user', content: 'hello' }] }); expect(sends).toBe(1);
    const failing = fixture(true, undefined, { providers: new Map([['stub', provider]]), events: { append: () => Promise.reject(new Error('event down')) } }); await expect(failing.gateway.chat({ feature: 'concierge', context, messages: [{ role: 'user', content: 'second' }] })).rejects.toThrow(/event down/); expect(sends).toBe(2);
  });
  it('keeps message boundaries in cache identity and rejects invalid token ceilings before send', async () => {
    const { gateway } = fixture(); const a = await gateway.chat({ feature: 'concierge', context, messages: [{ role: 'user', content: 'ab' }, { role: 'user', content: 'c' }] }); const b = await gateway.chat({ feature: 'concierge', context, messages: [{ role: 'user', content: 'a' }, { role: 'user', content: 'bc' }] }); expect(a.cacheHit).toBe(false); expect(b.cacheHit).toBe(false);
    const invalid = await gateway.chat({ feature: 'concierge', context, messages: [{ role: 'user', content: 'x' }], maxTokens: Number.POSITIVE_INFINITY }); expect(invalid).toMatchObject({ outcome: 'error', reason: 'PROVIDER_CALL_FAILED' });
  });
  it('records measured latency and content-free internal error reasons', async () => {
    const base = new StubProviderAdapter(); let tick = 100; const provider: AiProviderAdapter = { ...base, complete: () => Promise.reject(new Error('resident secret text')) };
    const { gateway, events } = fixture(true, undefined, { providers: new Map([['stub', provider]]), maxGatewayRetries: 0, now: () => ++tick }); const result = await gateway.chat({ feature: 'concierge', context, messages: [{ role: 'user', content: 'private details' }] });
    expect(result.reason).toBe('PROVIDER_CALL_FAILED'); expect(events[0]?.reason).toBe('PROVIDER_CALL_FAILED'); expect(events[0]?.reason).not.toContain('secret'); expect(events[0]?.latencyMs).toBeGreaterThan(0);
  });
});
