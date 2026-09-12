import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertMutationAuthority, commandPlan, runRole } from '../../../infra/railway/process-entrypoint.mjs';

const root = new URL('../../../', import.meta.url);
const contract = JSON.parse(readFileSync(new URL('infra/railway/deployment-contract.json', root), 'utf8')) as any;
const runbook = readFileSync(new URL('docs/railway-runbook.md', root), 'utf8');

describe('WP-040 production cutover preparation', () => {
  it('promotes one immutable digest instead of rebuilding production', () => {
    expect(contract.artifact.target).toBe('release');
    expect(contract.artifact.required_identity).toBe('IMAGE_DIGEST');
    expect(contract.artifact.promotion_rule).toMatch(/same resolved IMAGE_DIGEST/u);
    expect(runbook).toContain('Production is promotion, not rebuild');
    expect(runbook).toContain('OCI_REPOSITORY@IMAGE_DIGEST');
  });

  it('names required secrets without committing values and keeps live providers off', () => {
    expect(contract.required_secret_names).toEqual(expect.arrayContaining([
      'DATABASE_URL', 'FIELD_ENCRYPTION_KEY', 'ASSISTANCE_ENCRYPTION_KEY',
      'AUTH_TOKEN_PEPPER', 'CAREGIVER_RECIPIENT_HMAC_KEY', 'SENIORSOCIAL_EXPORT_KEYRING',
    ]));
    expect(contract.required_non_secret_settings).toMatchObject({
      NODE_ENV: 'production', DATABASE_SSL: 'require', ENABLE_HSTS: 'true',
      SMS_PROVIDER: 'simulator', AI_KILL_SWITCH_GLOBAL: 'true-until-separately-approved',
    });
    expect(JSON.stringify(contract)).not.toMatch(/postgres(?:ql)?:\/\/[^"\s]+:[^"\s]+@/iu);
  });

  it('requires explicit mutation authority and orders migrate before seed', () => {
    const sha = 'b'.repeat(40);
    expect(() => assertMutationAuthority('migrate-seed', {
      SEALED_CANDIDATE_SHA: sha, SENIORSOCIAL_SEED_ALLOWED: 'false',
    })).toThrow(/SEED_ALLOWED/u);
    expect(commandPlan('migrate-seed').map((command) => command.at(-1))).toEqual(['up', 'packages/db/seed/run.ts']);
  });

  it('stops immediately when migration fails and never starts seed', () => {
    const observed: string[][] = [];
    const status = runRole('migrate-seed', {
      SEALED_CANDIDATE_SHA: 'c'.repeat(40), SENIORSOCIAL_SEED_ALLOWED: 'true',
    }, (_file: string, args: string[]) => {
      observed.push(args);
      return { status: 17, error: undefined } as any;
    });
    expect(status).toBe(17);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toContain('packages/db/src/migrate.ts');
  });

  it('places leak scanning before any future upload and applies one-failure stop', () => {
    expect(runbook.indexOf('leak scanner')).toBeLessThan(runbook.indexOf('Build and push target `release`'));
    expect(runbook).toMatch(/Stop at the first\s+unexplained failure/u);
    expect(runbook).toContain('If the one rollback fails, mark cutover incomplete');
  });
});
