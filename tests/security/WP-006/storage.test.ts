import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = resolve('packages/db/migrations/0030_wp-006_audit_flags.sql');

describe('WP-006 durable storage controls', () => {
  // what_bug_this_catches: event tables permit mutation/deletion or tenant-unscoped access.
  it('forces tenant RLS and append-only privileges on audit and AI events', async () => {
    const sql = await readFile(migration, 'utf8');
    for (const table of ['audit_events', 'ai_events']) {
      expect(sql).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      expect(sql).toContain(`CREATE TRIGGER ${table}_immutable BEFORE UPDATE OR DELETE ON ${table}`);
    }
    expect(sql).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON audit_events, ai_events, flag_changes FROM seniorsocial_app');
    expect(sql).toContain("org_id = nullif(current_setting('app.current_org_id', true), '')::uuid");
  });

  // what_bug_this_catches: arbitrary keys can be inserted and silently become live configuration.
  it('enforces the closed flag vocabulary in SQL and has global plus org uniqueness', async () => {
    const sql = await readFile(migration, 'utf8');
    expect(sql).toContain("CHECK (flag_key IN (");
    expect(sql).toContain('CREATE UNIQUE INDEX feature_flags_global_key');
    expect(sql).toContain('CREATE UNIQUE INDEX feature_flags_org_key');
    expect(sql).toContain("CHECK ((scope = 'global' AND org_id IS NULL) OR (scope = 'org' AND org_id IS NOT NULL))");
  });

  it('scopes every mutation history row and prevents global actor metadata disclosure', async () => {
    const sql = await readFile(migration, 'utf8');
    expect(sql).toContain('org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT');
    expect(sql).toContain('FOREIGN KEY (org_id, actor_id) REFERENCES users(org_id, id)');
    expect(sql).not.toContain('org_id IS NULL OR org_id = nullif');
  });

  it('revokes direct mutation and narrowly grants the atomic security-definer function', async () => {
    const sql = await readFile(migration, 'utf8');
    expect(sql).toContain('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON flag_changes, feature_flags FROM seniorsocial_app');
    expect(sql).toContain('CREATE FUNCTION set_feature_flag(');
    expect(sql).toContain('SECURITY DEFINER\nSET search_path = pg_catalog, public');
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.set_feature_flag');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.set_feature_flag');
  });

  it('stores a test-safe trusted environment and all four explicit matrix columns', async () => {
    const sql = await readFile(migration, 'utf8');
    expect(sql).toContain("coalesce(nullif(current_setting('seniorsocial.deploy_environment', true), ''), 'test')");
    expect(sql).toContain('matrix(flag_key, dev, test, staging, production)');
    expect(sql).toContain('FROM configured_flag_defaults()');
  });

  // what_bug_this_catches: rollback cannot remove the WP-006 trigger/functions/tables cleanly.
  it('ships a reversible migration', async () => {
    const down = await readFile(resolve('packages/db/migrations/0030_wp-006_audit_flags.down.sql'), 'utf8');
    for (const object of ['flag_changes', 'feature_flags', 'audit_events', 'ai_events']) expect(down).toContain(`DROP TABLE IF EXISTS ${object}`);
    expect(down).toContain('DROP TRIGGER IF EXISTS orgs_seed_feature_flags ON orgs');
  });
});
