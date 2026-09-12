import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const up = readFileSync(new URL('../../../packages/db/migrations/0120_wp-018_intake.sql', import.meta.url), 'utf8');
const down = readFileSync(new URL('../../../packages/db/migrations/0120_wp-018_intake.down.sql', import.meta.url), 'utf8');

describe('WP-018 durable tenant contract', () => {
  it('stores no plaintext answer JSON and constrains AES-GCM material', () => {
    expect(up).not.toMatch(/\banswers\s+jsonb\b/iu);
    expect(up).toContain('answers_ciphertext bytea');
    expect(up).toContain('octet_length(answers_iv) = 12');
    expect(up).toContain('octet_length(answers_tag) = 16');
  });

  it('stores partial answers and constrained route facts under forced RLS', () => {
    expect(up).toContain("state IN ('draft','routed','closed')");
    expect(up.match(/FORCE ROW LEVEL SECURITY/g)).toHaveLength(2);
    expect(up).toContain('FOREIGN KEY (org_id,routed_category_id) REFERENCES service_categories(org_id,id)');
    expect(up).toContain("state IN ('routed','closed') AND disclaimer_acknowledged");
  });
  it('grants updates only on columns that exist after encrypted storage is introduced', () => {
    expect(up).not.toMatch(/GRANT\s+UPDATE\s*\([^)]*\banswers\b/iu);
    expect(up).toMatch(/GRANT\s+UPDATE\s*\([^)]*answers_ciphertext[^)]*answers_iv[^)]*answers_tag/iu);
  });
  it('provides append-only idempotency receipts and a reversible down migration', () => {
    expect(up).toContain('UNIQUE (org_id,resident_id,mutation_scope,idempotency_key)');
    expect(up).toContain('REVOKE DELETE,TRUNCATE,REFERENCES,TRIGGER');
    expect(down.indexOf('intake_mutations')).toBeLessThan(down.indexOf('intake_submissions'));
  });
  it('adopts canonical intake audit actions and refuses a lossy down migration', () => {
    expect(up).toContain("'intake.saved','intake.routed','intake.closed'");
    expect(down).toContain("WHERE action LIKE 'intake.%'");
    expect(down).toContain('cannot remove intake audit actions while durable events exist');
  });

  it('enforces draft-only mutation in the database, not only in repository code', () => {
    const updatePolicyGuardsDraft = /CREATE\s+POLICY[\s\S]*?FOR\s+UPDATE[\s\S]*?state\s*=\s*'draft'/iu.test(up);
    const triggerGuardsOldState = /OLD\.state\s*<>\s*'draft'/iu.test(up) &&
      /CREATE(?:\s+CONSTRAINT)?\s+TRIGGER\s+intake_submissions_guard_update[\s\S]*?wp018_guard_intake_update/iu.test(up);
    expect(updatePolicyGuardsDraft || triggerGuardsOldState).toBe(true);
  });
});
