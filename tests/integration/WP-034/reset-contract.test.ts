import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const up = new URL('../../../packages/db/migrations/0180_wp-034_demo.sql', import.meta.url);
const down = new URL('../../../packages/db/migrations/0180_wp-034_demo.down.sql', import.meta.url);
const runner = new URL('../../../packages/db/seed/demo/reset.ts', import.meta.url);
const cli = new URL('../../../packages/db/seed/demo/run.ts', import.meta.url);
const launcher = new URL('../../../scripts/lane-launch.mjs', import.meta.url);

describe('WP-034 migration/reset contract', () => {
  const requiredCleanup = [
    'policy_decisions','consent_scopes','consent_read_backs','consent_grants','caregiver_invitations','caregiver_links',
    'messaging_report_keys','messaging_reports','messaging_messages','messaging_conversations','intake_mutations','intake_submissions',
    'service_embeddings','service_accessibility','service_languages','services','service_imports','partners','service_categories',
    'notification_attempts','notification_outbox','notification_audit_pending','notification_inbox','print_jobs','print_requests','notification_preferences',
    'ai_cost_attempts','ai_events','ai_cost_reservations','ai_rate_limit_observations','ai_cache','ai_org_cost_caps','ai_cost_caps',
    'flag_changes','feature_flags','profiles','user_roles','users',
  ];
  it('uses one transaction-scoped advisory lock and deterministic replacement rather than additive seed writes', async () => {
    // what_bug_this_catches: concurrent or repeated resets accumulating stale reviewer state.
    const sql = await readFile(up, 'utf8');
    expect(sql).toContain('pg_advisory_xact_lock');
    expect(sql).toContain('DELETE FROM demo_accounts WHERE org_id=requested_org');
    expect(sql).toContain('DELETE FROM admin_mutations WHERE org_id=requested_org');
    expect(sql).toContain('DELETE FROM audit_events WHERE org_id=requested_org');
    expect(sql).toContain("expected_version constant text := 'wp-034.v1'");
    expect(sql).toContain("'2099-01-01T00:00:00Z'");
  });

  it('cleans every dependent workflow before identities and reseeds directory state', async () => {
    // what_bug_this_catches: a normal workflow FK blocking reset or stale directory/admin state surviving it.
    const sql = await readFile(up, 'utf8');
    for (const table of requiredCleanup) expect(sql).toContain(`DELETE FROM ${table} WHERE org_id=requested_org`);
    expect(sql.indexOf('DELETE FROM policy_decisions')).toBeLessThan(sql.indexOf('DELETE FROM users'));
    expect(sql.indexOf('DELETE FROM service_embeddings')).toBeLessThan(sql.indexOf('DELETE FROM services'));
    expect(sql.indexOf('DELETE FROM services')).toBeLessThan(sql.indexOf('DELETE FROM service_categories'));
    expect(sql).toContain('INSERT INTO partners');
    expect(sql).toContain('INSERT INTO services');
  });

  it('has an exact reversible migration pair', async () => {
    // what_bug_this_catches: migrate-down leaving callable elevated reset authority behind.
    const [upSql, downSql] = await Promise.all([readFile(up, 'utf8'), readFile(down, 'utf8')]);
    expect(upSql).toContain('CREATE FUNCTION seniorsocial_reset_demo');
    expect(downSql).toContain('DROP FUNCTION IF EXISTS seniorsocial_reset_demo');
    expect(downSql.match(/'demo\.reset'/gu)).toHaveLength(1);
    expect(downSql).toContain("'ai.recommended','ai.refused','ai.killed'\n));");
  });

  it('applies and validates the reviewer overlay inside the reset transaction', async () => {
    // what_bug_this_catches: an overlay committed after the base transaction, leaving a partially restored reviewer fixture.
    const source = await readFile(runner, 'utf8');
    const resetAt = source.indexOf('seniorsocial_reset_demo');
    const seedAt = source.indexOf('await seedDemoJourneyFixtures');
    const countsAt = source.indexOf('await readDemoCounts');
    expect(resetAt).toBeGreaterThan(0);
    expect(seedAt).toBeGreaterThan(resetAt);
    expect(countsAt).toBeGreaterThan(seedAt);
    expect(source.indexOf('return { fixture_version: DEMO_FIXTURE_VERSION')).toBeGreaterThan(countsAt);
  });

  it('seals and inserts the deterministic assistance fixture inside the reset boundary', async () => {
    // what_bug_this_catches: a literal placeholder ciphertext or post-commit assistance seed poisoning the staff queue.
    const [upSql, source] = await Promise.all([readFile(up, 'utf8'), readFile(runner, 'utf8')]);
    expect(upSql).not.toContain('synthetic-demo-ciphertext');
    expect(source).toContain('await assistanceCodec.seal(DEMO_ASSISTANCE_SUMMARY)');
    expect(source.indexOf('assistanceCodec.seal')).toBeLessThan(source.indexOf('client.begin'));
    const resetAt = source.indexOf('seniorsocial_reset_demo');
    const requestAt = source.indexOf('insert into assistance_requests');
    expect(requestAt).toBeGreaterThan(resetAt);
    expect(source.indexOf('await seedDemoJourneyFixtures')).toBeGreaterThan(requestAt);
  });

  it('constructs the runtime AES-GCM codec from required configuration before connecting', async () => {
    // what_bug_this_catches: the CLI opening a database before validating its encryption configuration or substituting a fixture-only codec.
    const source = await readFile(cli, 'utf8');
    expect(source).toContain('process.env.ASSISTANCE_ENCRYPTION_KEY');
    expect(source).toContain('new assistanceCodecModule.AesGcmNarrativeCodec(assistanceEncryptionKey)');
    expect(source.indexOf('new assistanceCodecModule.AesGcmNarrativeCodec')).toBeLessThan(source.indexOf('createDatabaseClient()'));
  });

  it('defaults the key only in the canonical local-demo launcher and leaves the direct seed fail closed', async () => {
    // what_bug_this_catches: repairing demo:reset by weakening the seed CLI or adding a production-capable fallback.
    const [launcherSource, cliSource] = await Promise.all([readFile(launcher, 'utf8'), readFile(cli, 'utf8')]);
    expect(launcherSource).toContain('ASSISTANCE_ENCRYPTION_KEY: inherited.ASSISTANCE_ENCRYPTION_KEY ?? LOCAL_DEMO_ASSISTANCE_ENCRYPTION_KEY');
    expect(launcherSource).toContain('const maintenance = demoMaintenanceEnvironment(env)');
    expect(cliSource).toContain("if (!assistanceEncryptionKey) throw new Error('ASSISTANCE_ENCRYPTION_KEY is required')");
    expect(cliSource).not.toContain('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
  });
});
