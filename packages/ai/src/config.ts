import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PromptRegistry, Route, Router } from './ports.ts';
import type { AiFeature } from './types.ts';
import { StaticPriceBook } from './memory.ts';

type PromptConfig = Record<AiFeature, { version: string; file: string }>;
type RouteConfig = Record<AiFeature, Route>;
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

export class FilePromptRegistry implements PromptRegistry {
  constructor(private readonly root = packageRoot) {}
  async get(feature: AiFeature) {
    const registry = JSON.parse(await readFile(join(this.root, 'prompts', 'registry.json'), 'utf8')) as PromptConfig;
    const entry = registry[feature];
    if (!entry) throw new Error(`prompt is not registered: ${feature}`);
    const text = await readFile(join(this.root, 'prompts', entry.file), 'utf8');
    return { ref: { feature, version: entry.version, hash: createHash('sha256').update(text).digest('hex') }, text };
  }
}
export class FileRouter implements Router {
  private config: RouteConfig | undefined;
  constructor(private readonly root = packageRoot, private readonly providerOverride = process.env.AI_PROVIDER) {}
  route(feature: AiFeature): Route {
    if (!this.config) throw new Error('FileRouter.load() must complete before route()');
    const route = this.config[feature];
    if (!route) throw new Error(`route is not configured: ${feature}`);
    if (!this.providerOverride) return route;
    if (!['stub','anthropic-api'].includes(this.providerOverride)) throw new Error('AI_PROVIDER must be stub or anthropic-api; CLI bridges are disabled');
    return { ...route, provider: this.providerOverride as Route['provider'], model: this.providerOverride === 'stub' ? 'test-stub' : route.model };
  }
  async load() { this.config = JSON.parse(await readFile(join(this.root, 'routing.json'), 'utf8')) as RouteConfig; return this; }
}
export async function loadPriceBook(root = packageRoot) {
  const prices = JSON.parse(await readFile(join(root, 'pricing.yml'), 'utf8')) as Readonly<Record<string, { inputPerMillionUsd: number; outputPerMillionUsd: number; cachedPerMillionUsd: number }>>;
  return new StaticPriceBook(prices);
}
