import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createServicesRepository } from '../../../packages/services/src/index.ts';

// what_bug_this_catches: a services table is added without FORCE RLS or an org-bound policy.
it('requires RLS and org policies on every WP-010 operational table', () => {
  const sql = readFileSync(new URL('../../../packages/db/migrations/0050_wp-010_services.sql', import.meta.url), 'utf8');
  for (const table of ['services', 'service_languages', 'service_accessibility', 'service_imports']) {
    expect(sql).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    expect(sql).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    expect(sql).toContain(`CREATE POLICY ${table}_org_isolation ON ${table}`);
  }
  expect(sql).toContain("publication_state text NOT NULL DEFAULT 'draft'");
  expect(sql).toContain('FOREIGN KEY (org_id, reviewed_by) REFERENCES users(org_id, id)');
});

describe('tenant-scoped repository', () => {
  // what_bug_this_catches: caller-controlled org data is interpolated into SQL or omitted from a query predicate.
  it('passes explicit org context through withOrg and parameterizes search values', async () => {
    const calls: { text: string; values: readonly (string | number | null)[] }[] = [];
    const withOrg = async <T>(orgId: string, work: (sql: { query: <R>(text: string, values: readonly (string | number | null)[]) => Promise<R[]>; audit: () => Promise<void> }) => Promise<T>) => {
      expect(orgId).toBe('11111111-1111-4111-8111-111111111111');
      return work({ query: async <R>(text: string, values: readonly (string | number | null)[]) => { calls.push({ text, values }); return [] as R[]; }, audit: async () => undefined });
    };
    await createServicesRepository(withOrg).search('11111111-1111-4111-8111-111111111111', { locale: 'es', query: "food' OR true --" });
    expect(calls[0]?.text).toContain('s.org_id = $1');
    expect(calls[0]?.text).not.toContain("food' OR true --");
    expect(calls[0]?.values[1]).toBe("food' OR true --");
    expect(calls[0]?.text).toContain("$3 = 'es'");
    expect(calls[0]?.text).toContain('order by rank desc');
  });
});
