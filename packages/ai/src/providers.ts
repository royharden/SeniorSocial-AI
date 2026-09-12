import type { AiMessage, AiProviderAdapter, AiProviderCapabilities, AiProviderResponse, AiToolSpec } from './types.ts';

export class EgressBlockedError extends Error {
  constructor(readonly rule: string) { super(`AI egress blocked by ${rule}`); this.name = 'EgressBlockedError'; }
}
export class AmbiguousProviderTimeoutError extends Error {
  constructor() { super('provider timeout has ambiguous billing status'); this.name = 'AmbiguousProviderTimeoutError'; }
}
export class ProviderUsageMissingError extends Error {
  constructor() { super('provider response omitted usage'); this.name = 'ProviderUsageMissingError'; }
}
export class PossiblyBilledProviderError extends Error {
  constructor() { super('provider transport failed after send began'); this.name = 'PossiblyBilledProviderError'; }
}
export interface SerializedTransport { send(body: Uint8Array, signal: AbortSignal): Promise<unknown> }
export interface EgressGuard { inspect(body: Uint8Array): void }

export class CanaryEgressGuard implements EgressGuard {
  constructor(private readonly canaries: readonly string[], private readonly deniedKeys: readonly string[] = ['serverFixture', 'databaseUrl', 'secret']) {}
  inspect(body: Uint8Array): void {
    const text = new TextDecoder().decode(body);
    const normalizedBody = text.normalize('NFKC');
    for (const canary of this.canaries) {
      if (!canary) continue;
      const normalized = canary.normalize('NFKC');
      const unicodeEscaped = canary.split('').map(character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
      const encoded = [...Buffer.from(canary, 'utf8')].map(byte => `%${byte.toString(16).padStart(2, '0')}`).join('');
      const base64 = Buffer.from(canary, 'utf8').toString('base64');
      const variants = [canary, normalized, JSON.stringify(canary).slice(1, -1), unicodeEscaped, unicodeEscaped.replaceAll('\\', '\\\\'), encoded, encoded.toUpperCase(), base64, base64.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')];
      if (variants.some(value => text.includes(value) || normalizedBody.includes(value.normalize('NFKC')))) throw new EgressBlockedError('canary');
    }
    for (const key of this.deniedKeys) if (new RegExp(`"${key}"\\s*:`, 'iu').test(text)) throw new EgressBlockedError(`denied-key:${key}`);
  }
}

const stubCapabilities: AiProviderCapabilities = { tools: true, structuredOutputs: true, streaming: false, embeddings: true, batch: false, promptCaching: false, maxConcurrency: 100, timeoutMs: 1000, samplingSchema: 'stub', acceptsTemperature: true, acceptsThinkingBudget: false, sdkRetriesDisabled: true };
export class StubProviderAdapter implements AiProviderAdapter {
  readonly id = 'stub' as const;
  readonly capabilities = stubCapabilities;
  complete(input: { readonly system: string; readonly messages: readonly AiMessage[]; readonly tools?: readonly AiToolSpec[]; readonly schema?: Readonly<Record<string, unknown>>; readonly maxTokens?: number; readonly temperature?: number; readonly signal: AbortSignal }): Promise<AiProviderResponse> {
    const value = input.messages.at(-1)?.content ?? '';
    const structured = input.schema ? stubForSchema(input.schema) : undefined;
    return Promise.resolve({ text: structured === undefined ? `stub:${value.trim()}` : JSON.stringify(structured), toolCalls: [], ...(structured === undefined ? {} : { structured }), usage: { tokensIn: Math.ceil((input.system.length + value.length) / 4), tokensOut: Math.ceil(value.length / 4), tokensCached: 0 }, model: 'test-stub', latencyMs: 0 });
  }
  embed(inputs: readonly string[]) { return Promise.resolve({ vectors: inputs.map(value => [value.length, value.length % 7]), dimensions: 2, model: 'test-stub', usage: { tokensIn: inputs.reduce((sum, value) => sum + Math.ceil(value.length / 4), 0), tokensOut: 0, tokensCached: 0 } }); }
}

function stubForSchema(schema: Readonly<Record<string, unknown>>): unknown {
  if (Array.isArray(schema.enum)) return schema.enum[0];
  if (schema.type === 'number') return 1;
  if (schema.type === 'string') return '';
  if (schema.type === 'boolean') return false;
  if (schema.type === 'array') return [];
  if (schema.type === 'object' && schema.properties && typeof schema.properties === 'object') return Object.fromEntries(Object.entries(schema.properties).map(([key, child]) => [key, stubForSchema(child as Readonly<Record<string, unknown>>)]));
  return {};
}

interface AnthropicWireResponse { content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number }; model?: string }
type ProviderInput = { readonly system: string; readonly messages: readonly AiMessage[]; readonly tools?: readonly AiToolSpec[]; readonly schema?: Readonly<Record<string, unknown>>; readonly maxTokens?: number; readonly temperature?: number; readonly signal: AbortSignal };
export class AnthropicProviderAdapter implements AiProviderAdapter {
  readonly id = 'anthropic-api' as const;
  readonly capabilities: AiProviderCapabilities;
  constructor(private readonly transport: SerializedTransport, private readonly guard: EgressGuard, private readonly model: string, timeoutMs = 15_000) {
    this.capabilities = { tools: true, structuredOutputs: true, streaming: false, embeddings: false, batch: false, promptCaching: true, maxConcurrency: 8, timeoutMs, samplingSchema: 'anthropic-haiku-4-5', acceptsTemperature: true, acceptsThinkingBudget: false, sdkRetriesDisabled: true };
  }
  serialize(input: Omit<ProviderInput, 'signal'>): Uint8Array {
    const system = [input.system, ...input.messages.filter(message => message.role === 'system').map(message => message.content)].join('\n');
    const wire: Record<string, unknown> = { model: this.model, max_tokens: input.maxTokens ?? 800, system, messages: input.messages.filter(message => message.role !== 'system').map(message => ({ role: message.role === 'tool_result' ? 'user' : message.role, content: message.content })) };
    if (input.tools) wire.tools = input.tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
    if (input.schema) wire.output_config = { format: { type: 'json_schema', schema: input.schema } };
    if (input.temperature !== undefined) wire.temperature = input.temperature;
    return new TextEncoder().encode(JSON.stringify(wire));
  }
  estimateSerializedBytes(input: Omit<ProviderInput, 'signal'>): number { return this.serialize(input).byteLength; }
  async complete(input: ProviderInput): Promise<AiProviderResponse> {
    const bytes = this.serialize(input);
    this.guard.inspect(bytes);
    const started = Date.now();
    let raw: AnthropicWireResponse;
    try { raw = await this.transport.send(bytes, input.signal) as AnthropicWireResponse; }
    catch { throw new PossiblyBilledProviderError(); }
    if (!raw.usage || typeof raw.usage.input_tokens !== 'number' || typeof raw.usage.output_tokens !== 'number') throw new ProviderUsageMissingError();
    const content = raw.content ?? [];
    const text = content.filter(item => item.type === 'text').map(item => item.text ?? '').join('');
    const toolCalls = content.filter(item => item.type === 'tool_use').map(item => ({ id: item.id ?? '', name: item.name ?? '', arguments: item.input ?? {} }));
    return { text, toolCalls, usage: { tokensIn: raw.usage.input_tokens, tokensOut: raw.usage.output_tokens, tokensCached: raw.usage.cache_read_input_tokens ?? 0 }, model: raw.model ?? this.model, latencyMs: Date.now() - started };
  }
}

/** Subscription bridges are documentation-only and cannot be enabled accidentally. */
export class DisabledCliBridgeAdapter implements AiProviderAdapter {
  readonly id: 'claude-cli-bridge' | 'codex-cli-bridge';
  readonly capabilities: AiProviderCapabilities = { ...stubCapabilities, tools: false, structuredOutputs: false, embeddings: false, maxConcurrency: 0, samplingSchema: 'stub' };
  constructor(id: 'claude-cli-bridge' | 'codex-cli-bridge') { this.id = id; }
  complete(): Promise<AiProviderResponse> { return Promise.reject(new Error('CLI subscription bridges are disabled in every environment')); }
}
