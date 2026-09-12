import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = (name: string) => readFileSync(new URL(`../../../packages/db/migrations/${name}`, import.meta.url), 'utf8');

describe('WP-013 storage invariants', () => {
  it('keeps accessibility structured plus verbatim and tenant-isolated', () => {
    const sql = migration('0071_wp-013_ride_requests.sql');
    expect(sql).toContain('code text NOT NULL'); expect(sql).toContain('verbatim_label text NOT NULL');
    expect(sql).toContain('ride accessibility handoff data is immutable'); expect(sql).toContain('FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('pickup_tz text NOT NULL');
  });

  it('stores append-only actor/time transitions and requires confirmation evidence', () => {
    const sql = migration('0072_wp-013_ride_transitions.sql');
    expect(sql).toContain('actor_id uuid NOT NULL'); expect(sql).toContain('at timestamptz NOT NULL');
    expect(sql).toContain("to_state <> 'confirmed_by' OR provider_evidence IS NOT NULL");
    expect(sql).toContain('ride transition history is immutable');
  });
});
