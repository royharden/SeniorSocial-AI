import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { schemas } from '@seniorsocial/contracts';
import { accountStateValues, localeValues, modeValues, roleValues } from '../../src/vocabulary.ts';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('WP-003 canonical schema contract', () => {
  // what_bug_this_catches: a database enum drifts from the already-adopted API vocabulary.
  it('CK-099 derives identity vocabularies from the contracts package', () => {
    const base = {
      user_id: '11111111-1111-4111-8111-111111111101',
      org_id: '11111111-1111-4111-8111-111111111111',
      roles: [...roleValues],
      mode: modeValues[0],
      locale: localeValues[0],
    };
    expect(schemas.Me.safeParse(base).success).toBe(true);
    for (const account_state of accountStateValues) {
      expect(schemas.User.safeParse({ account_state, version: 1 }).success).toBe(true);
    }
  });

  // what_bug_this_catches: a migration outside WP-003's range or an unpaired down migration makes rollback fail at integration.
  it('CK-099 keeps the migration in 0001-0009 with a reversible companion', async () => {
    const up = await readFile(join(packageRoot, 'migrations', '0001_wp-003_core_tables.sql'), 'utf8');
    const down = await readFile(join(packageRoot, 'migrations', '0001_wp-003_core_tables.down.sql'), 'utf8');
    expect(up).toContain('CREATE TABLE orgs');
    expect(down).toContain('DROP TABLE IF EXISTS orgs');
  });
});
