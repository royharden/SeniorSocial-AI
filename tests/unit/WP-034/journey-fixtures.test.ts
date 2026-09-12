import { expect, it } from 'vitest';
import {
  DEMO_CAREGIVER_LINK_ID, DEMO_FULL_EVENT_ID,
} from '../../../packages/db/seed/demo/data.ts';
import { clearPostMigrationDemoState, seedDemoJourneyFixtures, type DemoSeedSql } from '../../../packages/db/seed/demo/journey.ts';

it('seeds pending consent, deterministic capacity, and authoritative org-level AI-off state', async () => {
  // what_bug_this_catches: reviewer convenience data pre-authorizing caregiver access, leaving capacity nondeterministic, or inheriting an enabled global AI default.
  const statements: { sql: string; values: unknown[] }[] = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    statements.push({ sql: strings.join('?'), values });
    return Promise.resolve([]);
  }) as DemoSeedSql;

  await seedDemoJourneyFixtures(sql);

  expect(statements).toHaveLength(5);
  const source = statements.map(statement => statement.sql).join('\n');
  expect(source).toContain("caregiver_links(id,org_id,resident_id,caregiver_id,state,version)");
  expect(source).toContain("'pending',0");
  expect(source).not.toMatch(/insert into consent_(?:grants|scopes|read_backs)/u);
  expect(source).toContain("'attending'");
  expect(source).toContain("'waitlisted'");
  expect(source).toContain("scope='org' and flag_key in ('ai.master','ai.concierge')");
  expect(source).toContain('set enabled=false');
  expect(source).not.toMatch(/scope='global'/u);
  expect(statements.flatMap(statement => statement.values)).toEqual(expect.arrayContaining([
    DEMO_CAREGIVER_LINK_ID, DEMO_FULL_EVENT_ID,
  ]));
});

it('cleans post-migration tenant tables in dependency order', async () => {
  // what_bug_this_catches: a later workflow table retaining stale demo state or blocking identity replacement by FK.
  const statements: string[] = [];
  const sql = ((strings: TemplateStringsArray) => {
    statements.push(strings.join('?'));
    return Promise.resolve([]);
  }) as DemoSeedSql;
  await clearPostMigrationDemoState(sql);
  expect(statements.map(statement => statement.match(/delete from (\w+)/u)?.[1])).toEqual([
    'concierge_conversations', 'messaging_moderation_decisions', 'individual_report_exports', 'report_exports', 'report_source_imports',
    'report_channel_coverage', 'report_activity_facts',
  ]);
});
