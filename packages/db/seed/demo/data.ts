export const DEMO_RESET_VERSION = 'wp-034.v1';
export const DEMO_FIXTURE_VERSION = 'wp-034.v1+ss-n0.v1';
export const DEMO_ORG_ID = '11111111-1111-4111-8111-111111111111';
export const DEMO_ADMIN_ID = '34000000-0000-4000-8000-000000000006';
export const DEMO_RESIDENT_ID = '34000000-0000-4000-8000-000000000001';
export const DEMO_CAREGIVER_ID = '34000000-0000-4000-8000-000000000002';
export const DEMO_WAITLIST_USER_ID = '34000000-0000-4000-8000-000000000005';
export const DEMO_CAREGIVER_LINK_ID = '41000000-0000-4000-8100-000000000001';
export const DEMO_FULL_EVENT_ID = '41000000-0000-4000-8200-000000000001';
export const DEMO_ASSISTANCE_REQUEST_ID = '34000000-0000-4000-8200-000000000001';
export const DEMO_ASSISTANCE_SUMMARY = '[SYNTHETIC] Avery needs transportation help for a demo appointment.';

export const demoAccounts = Object.freeze([
  { role: 'senior', userId: '34000000-0000-4000-8000-000000000001', name: '[SYNTHETIC] Avery Example', email: 'senior.demo@example.invalid', code: 'DEMO-SENIOR' },
  { role: 'caregiver', userId: '34000000-0000-4000-8000-000000000002', name: '[SYNTHETIC] Casey Example', email: 'caregiver.demo@example.invalid', code: 'DEMO-CAREGIVER' },
  { role: 'staff', userId: '34000000-0000-4000-8000-000000000003', name: '[SYNTHETIC] Jordan Example', email: 'staff.demo@example.invalid', code: 'DEMO-STAFF' },
  { role: 'partner', userId: '34000000-0000-4000-8000-000000000004', name: '[SYNTHETIC] Morgan Example', email: 'partner.demo@example.invalid', code: 'DEMO-PARTNER' },
  { role: 'support', userId: '34000000-0000-4000-8000-000000000005', name: '[SYNTHETIC] Riley Example', email: 'support.demo@example.invalid', code: 'DEMO-SUPPORT' },
  { role: 'admin', userId: DEMO_ADMIN_ID, name: '[SYNTHETIC] Taylor Example', email: 'admin.demo@example.invalid', code: 'DEMO-ADMIN' },
] as const);

export const expectedDemoCounts = Object.freeze({
  users: 6,
  demo_accounts: 6,
  events: 8,
  event_rsvps: 2,
  full_event_attending: 1,
  full_event_waitlisted: 1,
  caregiver_invitations: 1,
  caregiver_links: 1,
  consent_grants: 0,
  consent_scopes: 0,
  consent_read_backs: 0,
  ai_master_disabled: 1,
  ai_concierge_disabled: 1,
  ai_events: 0,
  messaging_moderation_decisions: 0,
  report_activity_facts: 0,
  report_channel_coverage: 0,
  report_source_imports: 0,
  report_exports: 0,
  assistance_requests: 1,
  ride_requests: 1,
  moderation_items: 1,
  translation_drafts: 1,
  content_pages: 1,
  faqs: 1,
  announcements: 1,
  service_categories: 1,
  partners: 1,
  services: 1,
  policy_decisions: 0,
  notification_outbox: 0,
});

export function assertSyntheticFixture(): void {
  const roles = new Set(demoAccounts.map(account => account.role));
  if (roles.size !== 6) throw new Error('demo fixture must contain each canonical role exactly once');
  for (const account of demoAccounts) {
    if (!account.name.startsWith('[SYNTHETIC]')) throw new Error(`unlabelled demo identity: ${account.userId}`);
    if (!account.email.endsWith('@example.invalid')) throw new Error(`reachable demo email: ${account.userId}`);
  }
}
