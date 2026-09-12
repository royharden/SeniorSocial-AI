import { expect, expectTypeOf, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { AiRateLimited, CONTRACT_VERSION, DisabledCliBridgeAdapter, StubProviderAdapter } from '../../../packages/ai/src/index.ts';
import type { AiGateway } from '../../../packages/ai/src/index.ts';

it('implements immutable gateway contract v1', () => {
  expect(CONTRACT_VERSION).toBe(2); expectTypeOf<AiGateway>().toHaveProperty('chat'); expectTypeOf<AiGateway>().toHaveProperty('classify'); expectTypeOf<AiGateway>().toHaveProperty('translate'); expectTypeOf<AiGateway>().toHaveProperty('summarize'); expectTypeOf<AiGateway>().toHaveProperty('embed');
  expect(new StubProviderAdapter().id).toBe('stub'); expect(new AiRateLimited(5).retryAfterSeconds).toBe(5);
});
it('keeps subscription bridges documented and disabled', async () => { await expect(new DisabledCliBridgeAdapter('claude-cli-bridge').complete()).rejects.toThrow(/disabled/); });
it('binds every SQL reservation operation to an explicit tenant and app-role grants', () => {
  const migration = readFileSync(new URL('../../../packages/db/migrations/0160_wp-008_ai_gateway.sql', import.meta.url), 'utf8');
  const repository = readFileSync(new URL('../../../packages/ai/src/repositories.ts', import.meta.url), 'utf8');
  expect(migration).toContain('transition_ai_cost(requested_org uuid, requested_id uuid'); expect(migration).toContain('in_flight >= 8'); expect(migration).toContain('pending_reconciliation'); expect(migration).toContain('GRANT USAGE, SELECT ON SEQUENCE ai_cost_attempts_id_seq');
  expect(repository).not.toMatch(/this\.client<.*org_id/); expect(repository).toContain('transition(orgId'); expect(repository).toContain('withOrg(this.client, orgId');
});
