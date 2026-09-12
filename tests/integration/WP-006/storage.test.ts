import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AiEventRepository, AuditRepository, DurableAuditSink } from '../../../packages/audit/src/index.ts';
import { aiEnabled, flagKeys, FlagRepository } from '../../../packages/flags/src/index.ts';
import { createDatabaseClient, withOrg } from '../../../packages/db/src/index.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== '/seniorsocial_wp006_test') {
  throw new Error('WP-006 integration tests require a dedicated seniorsocial_wp006_test DATABASE_URL');
}
const owner = createDatabaseClient(databaseUrl);
const packageRoot = resolve('packages/db');
const runtimeRole = 'seniorsocial_wp006_test_login';
const runtimePassword = 'synthetic-test-only';
const runtimeUrl = new URL(databaseUrl);
runtimeUrl.username = runtimeRole;
runtimeUrl.password = runtimePassword;
const maple = '11111111-1111-4111-8111-111111111111';
const cedar = '22222222-2222-4222-8222-222222222222';
const actor = '11111111-1111-4111-8111-111111111101';
let runtime: ReturnType<typeof createDatabaseClient>;
const systemActor = '00000000-0000-4000-8000-000000000000';
const matrix = {
  'ai.master': [true, false, true, true], 'ai.concierge': [true, false, true, true],
  'ai.moderation': [true, false, true, true], 'ai.translation_assist': [true, false, true, true],
  'ai.triage': [true, false, true, true], 'ai.intake_routing': [true, false, true, true],
  'ai.event_rerank': [false, false, false, false], 'ai.conversation_starters': [false, false, false, false],
  'ai.summaries': [false, false, false, false], 'ai.provider.anthropic_api': [true, false, true, true],
  'ai.provider.cli_bridge': [false, false, false, false], 'ai.cache.exact_match': [true, true, true, true],
  'ai.batch.moderation': [false, false, true, true], 'rag.enabled': [false, false, false, false],
  'notify.sms.real_send': [false, false, false, false], 'notify.voice.real_send': [false, false, false, false],
  'notify.web_push': [false, false, false, false], 'messages.one_to_one': [true, true, true, true],
  'intake.health': [true, true, true, true], 'translate.review_queue_ui': [true, true, true, true],
  'admin.analytics_extended': [true, true, true, true], 'events.resident_proposals': [true, true, true, true],
  'easy_mode.voice_io': [true, true, true, true], 'demo.reset_endpoint': [true, true, true, false],
} as const;
const environments = ['dev', 'test', 'staging', 'production'] as const;

function migrate(direction: 'up' | 'down', url = databaseUrl): void {
  execFileSync(process.execPath, ['--import', 'tsx', 'src/migrate.ts', direction], {
    cwd: packageRoot, env: { ...process.env, DATABASE_URL: url, DATABASE_SSL: 'disable' }, stdio: 'pipe',
  });
}

describe('WP-006 PostgreSQL integration', () => {
  beforeAll(async () => {
    migrate('down');
    migrate('up');
    await owner`insert into orgs (id, name, slug) values (${maple}, 'Maple Test', 'maple-test'), (${cedar}, 'Cedar Test', 'cedar-test')`;
    await owner`insert into users (id, org_id, display_name) values (${actor}, ${maple}, 'Maple Admin'), ('22222222-2222-4222-8222-222222222201', ${cedar}, 'Cedar Admin')`;
    await owner`insert into user_roles (org_id, user_id, role) values (${maple}, ${actor}, 'admin'), (${cedar}, '22222222-2222-4222-8222-222222222201', 'admin')`;
    await owner.unsafe(`DROP ROLE IF EXISTS ${runtimeRole}`);
    await owner.unsafe(`CREATE ROLE ${runtimeRole} LOGIN PASSWORD '${runtimePassword}' IN ROLE seniorsocial_app`);
    runtime = createDatabaseClient(runtimeUrl.toString());
  }, 30_000);

  afterAll(async () => {
    if (runtime) await runtime.end();
    await owner.unsafe(`DROP ROLE IF EXISTS ${runtimeRole}`);
    await owner.end();
  });

  it('provisions the closed vocabulary at global and per-org scope', async () => {
    const flags = new FlagRepository(runtime);
    const page = await flags.list(maple);
    expect(page.items).toHaveLength(48);
    expect(page.items.filter(item => item.scope === 'global')).toHaveLength(24);
    expect(page.items.filter(item => item.scope === 'org')).toHaveLength(24);
    for (const key of flagKeys) {
      const expected = matrix[key][1];
      expect(page.items.find(item => item.key === key && item.scope === 'global')?.enabled, key).toBe(expected);
      expect(page.items.find(item => item.key === key && item.scope === 'org')?.enabled, key).toBe(expected);
    }
  });

  it('uses each trusted environment matrix for initial and newly inserted organisations', async () => {
    const adminUrl = new URL(databaseUrl); adminUrl.pathname = '/postgres';
    const admin = createDatabaseClient(adminUrl.toString());
    try {
      for (const [environmentIndex, environment] of environments.entries()) {
        const database = `seniorsocial_wp006_${environment}_matrix_test`;
        const url = new URL(databaseUrl); url.pathname = `/${database}`;
        await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
        await admin.unsafe(`CREATE DATABASE ${database}`);
        if (environment !== 'test') await admin.unsafe(`ALTER DATABASE ${database} SET seniorsocial.deploy_environment = '${environment}'`);
        migrate('up', url.toString());
        const scoped = createDatabaseClient(url.toString());
        try {
          const environmentRows = await scoped<{ environment: string }[]>`select environment from feature_flag_environment`;
          expect(environmentRows[0]?.environment).toBe(environment);
          await scoped`insert into orgs (id, name, slug) values ('33333333-3333-4333-8333-333333333333', 'New Org', 'new-org')`;
          const rows = await scoped<{ flag_key: string; scope: string; enabled: boolean }[]>`
            select flag_key, scope, enabled from feature_flags
            where scope = 'global' or org_id = '33333333-3333-4333-8333-333333333333'
          `;
          expect(rows).toHaveLength(48);
          for (const key of flagKeys) {
            const expected = matrix[key][environmentIndex];
            expect(rows.find(row => row.flag_key === key && row.scope === 'global')?.enabled, `${environment}:${key}:global`).toBe(expected);
            expect(rows.find(row => row.flag_key === key && row.scope === 'org')?.enabled, `${environment}:${key}:org`).toBe(expected);
          }
        } finally {
          await scoped.end();
        }
        migrate('down', url.toString());
        await admin.unsafe(`DROP DATABASE ${database} WITH (FORCE)`);
      }
    } finally {
      await admin.end();
    }
  }, 60_000);

  it('atomically changes one flag and appends one history plus schema-shaped audit row', async () => {
    const flags = new FlagRepository(runtime);
    const before = await owner<{ changes: number; audits: number }[]>`
      select (select count(*)::int from flag_changes) as changes,
             (select count(*)::int from audit_events) as audits
    `;
    await flags.set('ai.master', false, 'incident response', { orgId: maple, actorId: actor, scope: 'global', requestId: 'req-wp006' });
    const after = await owner<{ changes: number; audits: number }[]>`
      select (select count(*)::int from flag_changes) as changes,
             (select count(*)::int from audit_events) as audits
    `;
    expect(after[0]).toEqual({ changes: (before[0]?.changes ?? 0) + 1, audits: (before[0]?.audits ?? 0) + 1 });
    const audit = await new AuditRepository(runtime).list(maple, { action: 'flag.changed' });
    expect(audit.items[0]).toMatchObject({ actor: `user:${actor}`, target: 'flag:ai.master', org_id: maple, outcome: 'allowed', request_id: 'req-wp006' });
  });

  it('durably preserves sorted changed-field names without storing their values', async () => {
    await new DurableAuditSink(runtime).emit({
      actor: `user:${actor}`, action: 'service.updated', target: 'service:directory-entry-1',
      org_id: maple, outcome: 'allowed', reason: 'service updated', fields: ['phone', 'name_es'],
    });
    const page = await new AuditRepository(runtime).list(maple, { action: 'service.updated' });
    expect(page.items[0]?.fields).toEqual(['name_es', 'phone']);
  });

  it('durably accepts canonical notification actions without remapping their domain', async () => {
    await new DurableAuditSink(runtime).emit({
      actor: `user:${actor}`, action: 'notification.queued', target: 'notification:synthetic-1',
      org_id: maple, outcome: 'allowed', reason: 'required task notice queued',
    });
    const page = await new AuditRepository(runtime).list(maple, { action: 'notification.queued' });
    expect(page.items[0]).toMatchObject({ action: 'notification.queued', target: 'notification:synthetic-1' });
  });

  it('does not disclose a Maple global mutation actor or reason to Cedar', async () => {
    const flags = new FlagRepository(runtime);
    const before = await owner<{ updated_at: string }[]>`
      select updated_at::text from feature_flags where flag_key = 'ai.cache.exact_match' and scope = 'global'
    `;
    await flags.set('ai.cache.exact_match', false, 'Maple incident detail', { orgId: maple, actorId: actor, scope: 'global' });
    const mapleHistory = await withOrg(runtime, maple, transaction => transaction<{ actor_id: string; reason: string }[]>`
      select actor_id, reason from flag_changes where flag_key = 'ai.cache.exact_match'
    `);
    const cedarHistory = await withOrg(runtime, cedar, transaction => transaction<{ actor_id: string; reason: string }[]>`
      select actor_id, reason from flag_changes where flag_key = 'ai.cache.exact_match'
    `);
    expect(mapleHistory).toEqual([{ actor_id: actor, reason: 'Maple incident detail' }]);
    expect(cedarHistory).toEqual([]);
    const cedarFlags = await flags.list(cedar);
    expect(cedarFlags.items.find(item => item.key === 'ai.cache.exact_match' && item.scope === 'global')).toEqual({
      key: 'ai.cache.exact_match', enabled: false, scope: 'global', updated_by: systemActor,
    });
    const after = await owner<{ updated_at: string; updated_by: string }[]>`
      select updated_at::text, updated_by from feature_flags where flag_key = 'ai.cache.exact_match' and scope = 'global'
    `;
    expect(after[0]).toEqual({ updated_at: before[0]?.updated_at, updated_by: systemActor });
    expect(await flags.effective('ai.cache.exact_match', cedar)).toBe(false);
  });

  it('denies runtime direct updates and cross-org function calls', async () => {
    await expect(withOrg(runtime, maple, transaction => transaction`
      update feature_flags set enabled = true, updated_by = ${actor}, updated_at = now()
      where flag_key = 'ai.cache.exact_match' and scope = 'global'
    `)).rejects.toThrow('permission denied');
    await expect(withOrg(runtime, maple, transaction => transaction`
      select * from set_feature_flag(
        ${cedar}, '22222222-2222-4222-8222-222222222201', 'global'::flag_scope,
        'ai.cache.exact_match', true, 'cross tenant attempt', null
      )
    `)).rejects.toThrow('tenant context does not match');
  });

  it('enforces global AND org independently while leaving non-AI code paths unrelated', async () => {
    const flags = new FlagRepository(runtime);
    expect(await aiEnabled(flags, 'ai.concierge', maple)).toBe(false);
    await flags.set('ai.master', true, 'incident resolved', { orgId: maple, actorId: actor, scope: 'global' });
    await flags.set('ai.concierge', false, 'concierge maintenance', { orgId: maple, actorId: actor, scope: 'org' });
    expect(await aiEnabled(flags, 'ai.concierge', maple)).toBe(false);
    expect(await flags.effective('messages.one_to_one', maple)).toBe(true);
  });

  it('stores one AI event and prevents cross-org reads', async () => {
    const events = new AiEventRepository(runtime);
    await events.append({
      orgId: maple, requestId: 'req-ai', feature: 'concierge', promptVersion: 'v1', promptHash: 'abc',
      provider: 'stub', model: 'stub-v1', tokensIn: 1, tokensOut: 2, tokensCached: 0, latencyMs: 3,
      cacheHit: false, userRole: 'senior', onBehalfOf: null, outcome: 'ok', reason: null, costUsd: 0,
      reservationId: null, settledUsd: 0, usageKnown: true,
    });
    expect((await events.list(maple)).items).toHaveLength(1);
    expect((await events.list(cedar)).items).toHaveLength(0);
    expect((await new AuditRepository(runtime).list(cedar, { action: 'flag.changed' })).items).toHaveLength(0);
  });

  it('rejects update and delete against immutable event tables', async () => {
    await expect(owner`update audit_events set outcome = 'error'`).rejects.toThrow('append-only');
    await expect(owner`delete from ai_events`).rejects.toThrow('append-only');
  });
});
