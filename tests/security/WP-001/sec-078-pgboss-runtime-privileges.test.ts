import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL('../../../packages/db/migrations/0000_wp-001_pgboss.sql', import.meta.url);
const downUrl = new URL('../../../packages/db/migrations/0000_wp-001_pgboss.down.sql', import.meta.url);

describe('SEC-078 pg-boss runtime privileges', () => {
  // what_bug_this_catches: pg-boss starts by mutating the database schema as the
  // long-lived worker, forcing production to grant database-wide CREATE.
  it('pins the owner-provisioned pg-boss schema and grants only object-level runtime access', async () => {
    const migration = await readFile(migrationUrl, 'utf8');

    expect(migration).toContain("INSERT INTO pgboss.version(version) VALUES (37)");
    expect(migration).toContain('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pgboss FROM PUBLIC');
    expect(migration).toContain('GRANT USAGE ON SCHEMA pgboss TO seniorsocial_runtime');
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO seniorsocial_runtime',
    );
    expect(migration).toContain('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss TO seniorsocial_runtime');
    expect(migration).not.toMatch(/GRANT\s+CREATE\s+ON\s+DATABASE/iu);
    expect(migration).not.toMatch(/GRANT\s+ALL(?:\s+PRIVILEGES)?\s+ON\s+DATABASE/iu);
    expect(migration).not.toMatch(/ALTER\s+ROLE\s+seniorsocial_runtime[^;]*(?:SUPERUSER|CREATEDB|CREATEROLE)/iu);
  });

  // what_bug_this_catches: reset leaves queue state behind or drops an
  // application-owned schema because the rollback target is too broad.
  it('owns a reversible migration whose down plan removes only pgboss', async () => {
    const down = (await readFile(downUrl, 'utf8')).trim();
    expect(down).toBe('DROP SCHEMA IF EXISTS pgboss CASCADE;');
  });
});
