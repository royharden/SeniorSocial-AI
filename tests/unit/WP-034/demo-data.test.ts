import { describe, expect, it } from 'vitest';
import {
  DEMO_CAREGIVER_LINK_ID, DEMO_FIXTURE_VERSION, DEMO_FULL_EVENT_ID, DEMO_RESET_VERSION,
  assertSyntheticFixture, demoAccounts, expectedDemoCounts,
} from '../../../packages/db/seed/demo/data.ts';

describe('WP-034 demo manifest', () => {
  it('is one exact, visibly synthetic fixture with canonical role coverage', () => {
    // what_bug_this_catches: an unlabeled or reachable identity slipping into a demo artifact.
    expect(() => assertSyntheticFixture()).not.toThrow();
    expect(DEMO_RESET_VERSION).toBe('wp-034.v1');
    expect(DEMO_FIXTURE_VERSION).toBe('wp-034.v1+ss-n0.v1');
    expect(DEMO_CAREGIVER_LINK_ID).toBe('41000000-0000-4000-8100-000000000001');
    expect(DEMO_FULL_EVENT_ID).toBe('41000000-0000-4000-8200-000000000001');
    expect(demoAccounts.map(account => account.role).sort()).toEqual(['admin', 'caregiver', 'partner', 'senior', 'staff', 'support']);
    expect(new Set(demoAccounts.map(account => account.userId)).size).toBe(6);
    expect(demoAccounts.every(account => account.email.endsWith('@example.invalid'))).toBe(true);
  });

  it('pins exact reviewer-facing counts, including a zero outbound queue', () => {
    // what_bug_this_catches: a fixture edit silently changing the reviewer narrative or enabling delivery.
    expect(expectedDemoCounts).toEqual({ users: 6, demo_accounts: 6, events: 8, event_rsvps: 2,
      full_event_attending: 1, full_event_waitlisted: 1, caregiver_invitations: 1, caregiver_links: 1,
      consent_grants: 0, consent_scopes: 0, consent_read_backs: 0, assistance_requests: 1, ride_requests: 1,
      ai_master_disabled: 1, ai_concierge_disabled: 1, ai_events: 0,
      messaging_moderation_decisions: 0, report_activity_facts: 0, report_channel_coverage: 0,
      report_source_imports: 0, report_exports: 0,
      moderation_items: 1, translation_drafts: 1, content_pages: 1, faqs: 1, announcements: 1,
      service_categories: 1, partners: 1, services: 1, policy_decisions: 0, notification_outbox: 0 });
  });
});
