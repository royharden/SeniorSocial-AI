import { describe, expect, it } from 'vitest';
import { AnthropicProviderAdapter, CanaryEgressGuard, DefaultAiGateway, FixedWindowRateLimiter, InMemoryExactCache, InMemoryReservationStore, PossiblyBilledProviderError, StaticPriceBook } from '../../../packages/ai/src/index.ts';

describe('serialized outbound egress guard', () => {
  it('scans the actual bytes and blocks before injected transport on every call', async () => {
    let sends = 0; const adapter = new AnthropicProviderAdapter({ send: async () => { sends += 1; return {}; } }, new CanaryEgressGuard(['CANARY-DO-NOT-SEND']), 'claude-haiku-4-5');
    await expect(adapter.complete({ system: 'safe', messages: [{ role: 'user', content: 'CANARY-DO-NOT-SEND' }], signal: new AbortController().signal })).rejects.toThrow(/egress blocked/);
    expect(sends).toBe(0); expect(adapter.capabilities.sdkRetriesDisabled).toBe(true);
  });
  it.each([
    'CANARY-DO-NOT-SEND',
    '\\u0043\\u0041\\u004e\\u0041\\u0052\\u0059\\u002d\\u0044\\u004f\\u002d\\u004e\\u004f\\u0054\\u002d\\u0053\\u0045\\u004e\\u0044',
    'CANARY-DO-NOT-SEND'.split('').map(character => `%${character.charCodeAt(0).toString(16)}`).join(''),
    Buffer.from('CANARY-DO-NOT-SEND').toString('base64'),
    'ＣＡＮＡＲＹ－ＤＯ－ＮＯＴ－ＳＥＮＤ',
  ])('blocks encoded canary representation %s', async representation => {
    let sends = 0; const adapter = new AnthropicProviderAdapter({ send: async () => { sends += 1; return {}; } }, new CanaryEgressGuard(['CANARY-DO-NOT-SEND']), 'claude-haiku-4-5');
    await expect(adapter.complete({ system: 'safe', messages: [{ role: 'user', content: representation }], signal: new AbortController().signal })).rejects.toThrow(/egress blocked/); expect(sends).toBe(0);
  });
  it('serializes only the provider allowlist', async () => {
    let body = ''; const adapter = new AnthropicProviderAdapter({ send: async bytes => { body = new TextDecoder().decode(bytes); return { model: 'claude-haiku-4-5', content: [], usage: { input_tokens: 1, output_tokens: 1 } }; } }, new CanaryEgressGuard([]), 'claude-haiku-4-5');
    await adapter.complete({ system: 'safe', messages: [{ role: 'user', content: 'hello' }], signal: new AbortController().signal });
    expect(Object.keys(JSON.parse(body) as object).sort()).toEqual(['max_tokens','messages','model','system']);
  });
  it('classifies a generic after-send transport loss as possibly billed', async () => {
    const adapter = new AnthropicProviderAdapter({ send: () => Promise.reject(new Error('socket reset with secret response')) }, new CanaryEgressGuard([]), 'claude-haiku-4-5');
    await expect(adapter.complete({ system: 'safe', messages: [{ role: 'user', content: 'hello' }], signal: new AbortController().signal })).rejects.toBeInstanceOf(PossiblyBilledProviderError);
  });
  it('bounds the complete Unicode/tool/schema wire representation', async () => {
    let bytes = 0; const adapter = new AnthropicProviderAdapter({ send: async body => { bytes = body.byteLength; return { model: 'claude-haiku-4-5', content: [], usage: { input_tokens: 1, output_tokens: 1 } }; } }, new CanaryEgressGuard([]), 'claude-haiku-4-5');
    const input = { system: '🙂', messages: [{ role: 'user' as const, content: '¿Dónde?' }], tools: [{ name: 'searchDirectory', description: 'buscar', parameters: { type: 'object' } }], schema: { type: 'object' }, maxTokens: 10, temperature: 0 };
    const estimate = adapter.estimateSerializedBytes(input); await adapter.complete({ ...input, signal: new AbortController().signal }); expect(estimate).toBe(bytes); expect(bytes).toBeGreaterThan(input.system.length + input.messages[0]!.content.length);
  });
  it('does not reach transport or retry after the egress guard fires', async () => {
    let sends = 0; const adapter = new AnthropicProviderAdapter({ send: async () => { sends += 1; return {}; } }, new CanaryEgressGuard(['BLOCK-ME']), 'claude-haiku-4-5'); const events: unknown[] = [];
    const gateway = new DefaultAiGateway({ flags: { effective: async key => key !== 'ai.cache.exact_match' }, events: { append: async event => { events.push(event); return { id: 'event' }; } }, prompts: { get: async feature => ({ ref: { feature, version: 'v1', hash: 'hash' }, text: 'safe' }) }, router: { route: () => ({ provider: 'anthropic-api', model: 'claude-haiku-4-5', maxOutputTokens: 10 }) }, providers: new Map([['anthropic-api', adapter]]), rateLimiter: new FixedWindowRateLimiter(), reservations: new InMemoryReservationStore(1), cache: new InMemoryExactCache(), cacheBoundary: { describe: async () => ({ cacheable: false, sourceContentVersionSet: [] }), reauthorize: async () => false }, prices: new StaticPriceBook({ 'anthropic-api:claude-haiku-4-5': { inputPerMillionUsd: 1, outputPerMillionUsd: 5, cachedPerMillionUsd: 0 } }), maxGatewayRetries: 1 });
    const result = await gateway.chat({ feature: 'concierge', context: { orgId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222', userRole: 'senior', locale: 'en', requestId: 'egress' }, messages: [{ role: 'user', content: 'BLOCK-ME' }] });
    expect(result.outcome).toBe('egress_blocked'); expect(sends).toBe(0); expect(events).toHaveLength(1);
  });
});
