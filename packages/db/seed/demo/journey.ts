import {
  DEMO_CAREGIVER_ID, DEMO_CAREGIVER_LINK_ID, DEMO_FULL_EVENT_ID, DEMO_ORG_ID,
  DEMO_RESIDENT_ID, DEMO_WAITLIST_USER_ID,
} from './data.ts';

export interface DemoSeedSql {
  <T extends Record<string, unknown>[] = Record<string, unknown>[]>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

export async function seedDemoJourneyFixtures(sql: DemoSeedSql): Promise<void> {
  await sql`insert into caregiver_invitations
    (id,org_id,resident_id,recipient_digest,token_digest,relationship_note,created_at,expires_at,accepted_at,caregiver_id)
    values ('41000000-0000-4000-8100-000000000002',${DEMO_ORG_ID}::uuid,${DEMO_RESIDENT_ID}::uuid,
      ${'a'.repeat(64)},${'b'.repeat(64)},'[SYNTHETIC] Accepted locally; resident must confirm every scope.',
      '2026-09-11T12:00:00Z','2026-09-12T12:00:00Z','2026-09-11T12:05:00Z',${DEMO_CAREGIVER_ID}::uuid)`;
  await sql`insert into caregiver_links(id,org_id,resident_id,caregiver_id,state,version)
    values (${DEMO_CAREGIVER_LINK_ID}::uuid,${DEMO_ORG_ID}::uuid,${DEMO_RESIDENT_ID}::uuid,${DEMO_CAREGIVER_ID}::uuid,'pending',0)`;
  await sql`insert into events(id,org_id,title,starts_at,time_zone,location,capacity,accessibility,published_at,created_by,created_at)
    values (${DEMO_FULL_EVENT_ID}::uuid,${DEMO_ORG_ID}::uuid,'[SYNTHETIC] Full-capacity reviewer event',
      '2026-09-21T14:00:00Z','America/New_York','[SYNTHETIC] Maple Harbor Library Room',1,ARRAY['step-free'],
      '2026-09-01T12:00:00Z','34000000-0000-4000-8000-000000000003','2026-09-01T12:00:00Z')`;
  await sql`insert into event_rsvps(id,org_id,event_id,user_id,state,waitlisted_at,created_at,updated_at) values
    ('41000000-0000-4000-8200-000000000002',${DEMO_ORG_ID}::uuid,${DEMO_FULL_EVENT_ID}::uuid,${DEMO_CAREGIVER_ID}::uuid,'attending',NULL,'2026-09-01T12:00:00Z','2026-09-01T12:00:00Z'),
    ('41000000-0000-4000-8200-000000000003',${DEMO_ORG_ID}::uuid,${DEMO_FULL_EVENT_ID}::uuid,${DEMO_WAITLIST_USER_ID}::uuid,'waitlisted','2026-09-01T12:01:00Z','2026-09-01T12:01:00Z','2026-09-01T12:01:00Z')`;
  await sql`update feature_flags set enabled=false,
      updated_by='00000000-0000-4000-8000-000000000000',updated_at='2026-09-01T12:00:00Z'
    where org_id=${DEMO_ORG_ID}::uuid and scope='org' and flag_key in ('ai.master','ai.concierge')`;
}

export async function clearPostMigrationDemoState(sql: DemoSeedSql): Promise<void> {
  // These tenant tables were integrated after the immutable WP-034 reset migration.
  // Keep them in the same maintenance transaction so their FKs cannot block reset.
  await sql`delete from concierge_conversations where org_id=${DEMO_ORG_ID}::uuid`;
  await sql`delete from messaging_moderation_decisions where org_id=${DEMO_ORG_ID}::uuid`;
  await sql`delete from individual_report_exports where org_id=${DEMO_ORG_ID}::uuid`;
  await sql`delete from report_exports where org_id=${DEMO_ORG_ID}::uuid`;
  await sql`delete from report_source_imports where org_id=${DEMO_ORG_ID}::uuid`;
  await sql`delete from report_channel_coverage where org_id=${DEMO_ORG_ID}::uuid`;
  await sql`delete from report_activity_facts where org_id=${DEMO_ORG_ID}::uuid`;
}

export async function readDemoCounts(sql: DemoSeedSql): Promise<Record<string, number>> {
  const rows = await sql<Array<Record<string, number>>>`select
    (select count(*)::int from users where org_id=${DEMO_ORG_ID}::uuid) users,
    (select count(*)::int from demo_accounts where org_id=${DEMO_ORG_ID}::uuid) demo_accounts,
    (select count(*)::int from events where org_id=${DEMO_ORG_ID}::uuid) events,
    (select count(*)::int from event_rsvps where org_id=${DEMO_ORG_ID}::uuid) event_rsvps,
    (select count(*)::int from event_rsvps where org_id=${DEMO_ORG_ID}::uuid and event_id=${DEMO_FULL_EVENT_ID}::uuid and state='attending') full_event_attending,
    (select count(*)::int from event_rsvps where org_id=${DEMO_ORG_ID}::uuid and event_id=${DEMO_FULL_EVENT_ID}::uuid and state='waitlisted') full_event_waitlisted,
    (select count(*)::int from caregiver_invitations where org_id=${DEMO_ORG_ID}::uuid) caregiver_invitations,
    (select count(*)::int from caregiver_links where org_id=${DEMO_ORG_ID}::uuid) caregiver_links,
    (select count(*)::int from consent_grants where org_id=${DEMO_ORG_ID}::uuid) consent_grants,
    (select count(*)::int from consent_scopes where org_id=${DEMO_ORG_ID}::uuid) consent_scopes,
    (select count(*)::int from consent_read_backs where org_id=${DEMO_ORG_ID}::uuid) consent_read_backs,
    (select count(*)::int from feature_flags where org_id=${DEMO_ORG_ID}::uuid and scope='org' and flag_key='ai.master' and enabled=false) ai_master_disabled,
    (select count(*)::int from feature_flags where org_id=${DEMO_ORG_ID}::uuid and scope='org' and flag_key='ai.concierge' and enabled=false) ai_concierge_disabled,
    (select count(*)::int from ai_events where org_id=${DEMO_ORG_ID}::uuid) ai_events,
    (select count(*)::int from messaging_moderation_decisions where org_id=${DEMO_ORG_ID}::uuid) messaging_moderation_decisions,
    (select count(*)::int from report_activity_facts where org_id=${DEMO_ORG_ID}::uuid) report_activity_facts,
    (select count(*)::int from report_channel_coverage where org_id=${DEMO_ORG_ID}::uuid) report_channel_coverage,
    (select count(*)::int from report_source_imports where org_id=${DEMO_ORG_ID}::uuid) report_source_imports,
    (select count(*)::int from report_exports where org_id=${DEMO_ORG_ID}::uuid) report_exports,
    (select count(*)::int from assistance_requests where org_id=${DEMO_ORG_ID}::uuid) assistance_requests,
    (select count(*)::int from ride_requests where org_id=${DEMO_ORG_ID}::uuid) ride_requests,
    (select count(*)::int from moderation_items where org_id=${DEMO_ORG_ID}::uuid) moderation_items,
    (select count(*)::int from translation_drafts where org_id=${DEMO_ORG_ID}::uuid) translation_drafts,
    (select count(*)::int from content_pages where org_id=${DEMO_ORG_ID}::uuid) content_pages,
    (select count(*)::int from faqs where org_id=${DEMO_ORG_ID}::uuid) faqs,
    (select count(*)::int from announcements where org_id=${DEMO_ORG_ID}::uuid) announcements,
    (select count(*)::int from service_categories where org_id=${DEMO_ORG_ID}::uuid) service_categories,
    (select count(*)::int from partners where org_id=${DEMO_ORG_ID}::uuid) partners,
    (select count(*)::int from services where org_id=${DEMO_ORG_ID}::uuid) services,
    (select count(*)::int from policy_decisions where org_id=${DEMO_ORG_ID}::uuid) policy_decisions,
    (select count(*)::int from notification_outbox where org_id=${DEMO_ORG_ID}::uuid) notification_outbox`;
  const counts = rows[0];
  if (!counts) throw new Error('demo fixture count query returned no result');
  return counts;
}
