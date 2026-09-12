import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createRagRepository, createReindexContextResolver } from '../../../packages/rag/src/index.ts';

describe('WP-023 contracts', () => {
  // what_bug_this_catches: integration drift changes the locked result into generated prose or provider-specific output.
  it('locks the result projection to service_id and numeric score', async () => {
    const repository = createRagRepository(async (_orgId, work) => work({
      query: async <T>() => [{ service_id: '11111111-1111-4111-8111-111111111151', score: 'NaN' }] as T[],
    }));
    const hits = await repository.hybrid('11111111-1111-4111-8111-111111111111', 'meals', 'en', [1, 2], 2, 5);
    expect(hits).toEqual([{ service_id: '11111111-1111-4111-8111-111111111151', score: 0 }]);
    expect(Object.keys(hits[0] ?? {})).toEqual(['service_id', 'score']);
  });

  // what_bug_this_catches: a future implementation bypasses WP-008 by importing a provider SDK in packages/rag.
  it('contains no provider imports and hard-codes the only permitted gateway feature', async () => {
    const service = await readFile(new URL('../../../packages/rag/src/service.ts', import.meta.url), 'utf8');
    const packageSource = await Promise.all(['index.ts', 'repository.ts', 'service.ts', 'types.ts', 'validation.ts']
      .map(name => readFile(new URL(`../../../packages/rag/src/${name}`, import.meta.url), 'utf8')));
    expect(packageSource.join('\n')).not.toMatch(/voyage|anthropic|openai-api|providers\.ts/iu);
    expect(service).toContain("feature: 'concierge'");
  });

  // what_bug_this_catches: queue-supplied org/actor authority replaces trusted published-service resolution.
  it('resolves tenant and gateway user only from the globally unique published service', async () => {
    let statement = ''; let values: readonly string[] = [];
    const resolver = createReindexContextResolver({ query: async <T>(text: string, input: readonly string[]) => {
      statement = text; values = input;
      return [{ org_id: '11111111-1111-4111-8111-111111111111',
        reviewed_by: '11111111-1111-4111-8111-111111111101' }] as T[];
    } });
    await expect(resolver.resolveService('11111111-1111-4111-8111-111111111151')).resolves.toEqual({
      orgId: '11111111-1111-4111-8111-111111111111', gatewayUserId: '11111111-1111-4111-8111-111111111101',
    });
    expect(values).toEqual(['11111111-1111-4111-8111-111111111151']);
    expect(statement).toContain("publication_state='published'");
    expect(statement).toContain('reviewed_by is not null');
    const types = await readFile(new URL('../../../packages/rag/src/types.ts', import.meta.url), 'utf8');
    const payload = types.match(/export interface ReindexJob \{(?<body>[^}]+)\}/u)?.groups?.body ?? '';
    expect(payload.match(/readonly [a-z_]+:/gu)?.sort()).toEqual([
      'readonly idempotency_key:', 'readonly service_id:',
    ]);
  });

  // what_bug_this_catches: two workers race a replacement without locking and a stale vector wins last-write-wins.
  it('serializes replacement before idempotency and freshness checks', async () => {
    const statements: string[] = [];
    const repository = createRagRepository(async (_orgId, work) => work({ query: async <T>(text: string) => {
      statements.push(text);
      if (text.includes('select s.id')) return [{ id: '11111111-1111-4111-8111-111111111151', content: 'Meals',
        content_version: '2026-09-10T12:00:00.000000Z', content_fingerprint: 'a'.repeat(32),
        idempotency_key: null }] as T[];
      return [] as T[];
    } }));
    await expect(repository.replace({ orgId: '11111111-1111-4111-8111-111111111111',
      serviceId: '11111111-1111-4111-8111-111111111151', idempotencyKey: 'job-1',
      contentVersion: '2026-09-10T12:00:00.000000Z', contentFingerprint: 'a'.repeat(32),
      embedding: [1, 2], dimensions: 2, model: 'stub' })).resolves.toBe('indexed');
    expect(statements[0]).toContain('for update of s');
    expect(statements[1]).toContain("'system:rag-reindex'");
  });
});
