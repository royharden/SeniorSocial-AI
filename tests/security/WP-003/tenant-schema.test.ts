import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = resolve('packages/db/migrations/0001_wp-003_core_tables.sql');

describe('WP-003 tenant schema defense', () => {
  // what_bug_this_catches: an operational table silently lands without a mandatory tenant key.
  it('SEC-011 gives every operational table a NOT NULL org_id', async () => {
    const source = await readFile(migrationPath, 'utf8');
    for (const table of ['users', 'user_roles', 'profiles', 'service_categories', 'partners']) {
      const definition = source.match(new RegExp(`CREATE TABLE ${table} \\(([\\s\\S]*?)\\n\\);`, 'u'))?.[1];
      expect(definition, `missing ${table}`).toBeDefined();
      expect(definition).toMatch(/org_id uuid NOT NULL/u);
    }
  });

  // what_bug_this_catches: the database runtime role can bypass row policies or destructively truncate tenant data.
  it('SEC-074 creates a constrained runtime role and forced RLS policies', async () => {
    const source = await readFile(migrationPath, 'utf8');
    expect(source).toContain('NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS');
    expect(source).toContain('REVOKE TRUNCATE, REFERENCES, TRIGGER');
    for (const table of ['orgs', 'users', 'user_roles', 'profiles', 'service_categories', 'partners']) {
      expect(source).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      expect(source).toContain(`CREATE POLICY ${table === 'orgs' ? 'orgs_org_isolation' : `${table}_org_isolation`} ON ${table}`);
    }
  });
});
