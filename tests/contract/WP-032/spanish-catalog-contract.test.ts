import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import policy from '../../../packages/i18n/es/catalog-policy.json';

const root = resolve(import.meta.dirname, '../../..');
const englishRoot = resolve(root, 'packages/i18n/en');
const spanishRoot = resolve(root, 'packages/i18n/es');

describe('WP-032 Spanish catalog contract', () => {
  it('has exactly one Spanish content and status catalog for every current English namespace', async () => {
    // what_bug_this_catches: silent fallback caused by missing topology or an invented Spanish-only namespace.
    const english = (await readdir(englishRoot)).filter(name => name.endsWith('.json')).sort();
    const spanish = (await readdir(spanishRoot))
      .filter(name => name.endsWith('.json') && !name.endsWith('.status.json') && name !== 'catalog-policy.json')
      .sort();
    const statuses = (await readdir(spanishRoot)).filter(name => name.endsWith('.status.json')).sort();
    expect(spanish).toEqual(english);
    expect(statuses).toEqual(english.map(name => name.replace(/\.json$/u, '.status.json')));
    expect(Object.keys(policy.current_source_namespaces).sort()).toEqual(
      english.map(name => name.replace(/\.json$/u, '')).sort(),
    );
    for (const name of spanish) {
      await expect(readFile(resolve(spanishRoot, name.replace(/\.json$/u, '.status.json')), 'utf8')).resolves.toBeTruthy();
    }
  });

  it('binds every status source_version to the exact current English source bytes', async () => {
    // what_bug_this_catches: reviewed/draft metadata surviving after its English source catalog changes.
    for (const [namespace, source] of Object.entries(policy.current_source_namespaces)) {
      const bytes = await readFile(resolve(englishRoot, `${namespace}.json`));
      const digest = createHash('sha256').update(bytes).digest('hex');
      expect(digest).toBe(source.source_sha256);
      expect(source.source_version).toBe(`sha256:${digest}`);
      const statuses = JSON.parse(await readFile(resolve(spanishRoot, `${namespace}.status.json`), 'utf8')) as
        Record<string, { source_version: string }>;
      expect(new Set(Object.values(statuses).map(entry => entry.source_version))).toEqual(new Set([`sha256:${digest}`]));
    }
  });

  it('uses every normative namespace and covers the required WP-009 catalog groups', async () => {
    // what_bug_this_catches: notification/print copy being split into invented namespaces or omitting minimal-body safety copy.
    expect(policy.current_auth_catalogs).toMatchObject({ english: ['auth'], spanish: ['auth'] });
    expect(Object.keys(policy.current_source_namespaces).sort()).toEqual([
      'admin', 'assistance', 'auth', 'caregiver', 'common', 'events', 'groups', 'intake',
      'messages', 'notify', 'profile', 'reports', 'rides', 'services', 'shell', 'translate',
    ]);
    const notify = JSON.parse(await readFile(resolve(englishRoot, 'notify.json'), 'utf8')) as Record<string, string>;
    for (const prefix of ['settings.', 'purpose.', 'channel.', 'quiet_hours.', 'print.']) {
      expect(Object.keys(notify).some(key => key.startsWith(prefix))).toBe(true);
    }
    expect(notify).toHaveProperty('body.minimal');
    expect(notify).toHaveProperty('print.source_unavailable');
    expect(notify).toMatchObject({
      'settings.no_outbound': 'No outbound notices',
      'settings.shared_device': 'I share this phone or device',
      'quiet_hours.intro': 'Optional notices wait until quiet hours end. Urgent assistance notices may arrive during quiet hours.',
      'print.link': 'Open printable schedule',
      'print.title': 'Printable schedule',
      'print.snapshot_warning': 'This copy reflects the source at that time. Later changes do not update or recall this printed copy. Check your current schedule before making plans.',
      'body.minimal': 'You have a new notification. Sign in securely.',
    });
    const spanishNotify = JSON.parse(await readFile(resolve(spanishRoot, 'notify.json'), 'utf8')) as Record<string, string>;
    expect(spanishNotify['body.minimal']).toBe('Tiene una nueva notificación. Inicie sesión de forma segura.');
    for (const namespace of ['notifications', 'print', 'directory']) {
      await expect(readFile(resolve(englishRoot, `${namespace}.json`), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(resolve(spanishRoot, `${namespace}.json`), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('preserves machine-readable IANA identifiers as an explicit identical-value exception', async () => {
    // what_bug_this_catches: translating an IANA identifier into a value that application time-zone parsing cannot use.
    const english = JSON.parse(await readFile(resolve(englishRoot, 'events.json'), 'utf8')) as Record<string, string>;
    const spanish = JSON.parse(await readFile(resolve(spanishRoot, 'events.json'), 'utf8')) as Record<string, string>;
    expect(english['proposal.timezone_example']).toBe('America/New_York');
    expect(spanish['proposal.timezone_example']).toBe('America/New_York');
    expect(policy.approved_source_identical_values).toContainEqual({
      key: 'events.proposal.timezone_example',
      reason: 'America/New_York is a machine-readable IANA time-zone identifier and must remain byte-identical.',
    });
  });

  it('covers the integrated closed state and option vocabularies', async () => {
    // what_bug_this_catches: a backend state leaking as an untranslated raw enum after the catalog appears complete.
    const expected = {
      assistance: [
        'status.closed_unable', 'status.in_progress', 'status.owned', 'status.pending_unowned', 'status.resolved',
        'triage.food', 'triage.general', 'triage.housing', 'triage.immediate_safety', 'triage.social_support',
        'triage.transportation', 'triage_source.ai', 'triage_source.rules', 'triage_source.staff',
      ],
      caregiver: [
        'read_back.book_rides', 'read_back.manage_events', 'read_back.receive_alerts', 'read_back.view_assistance',
        'read_back.view_profile', 'read_back.view_schedule', 'status.active', 'status.pending', 'status.revoked',
      ],
      events: [
        'proposal_status.declined', 'proposal_status.proposed', 'proposal_status.published',
        'status.attending', 'status.cancelled', 'status.waitlisted',
      ],
      intake: ['state.closed', 'state.draft', 'state.routed'],
      notify: [
        'channel.email', 'channel.sms', 'channel.voice', 'purpose.event_reminder', 'purpose.forums_digest',
        'purpose.message', 'purpose.recommendations', 'purpose.task_notice', 'purpose.urgent_assistance',
        'state.ambiguous', 'state.delivered', 'state.pending', 'state.send_failed', 'state.sending', 'state.suppressed',
      ],
      rides: [
        'mode.paratransit', 'mode.partner_van', 'mode.rideshare', 'mode.taxi_voucher',
        'status.cancelled', 'status.completed', 'status.confirmed_by', 'status.draft', 'status.requested',
        'status.unable_to_fulfill', 'status.waiting_for_dispatcher',
      ],
    } as const;
    for (const [namespace, keys] of Object.entries(expected)) {
      const english = JSON.parse(await readFile(resolve(englishRoot, `${namespace}.json`), 'utf8')) as Record<string, string>;
      const spanish = JSON.parse(await readFile(resolve(spanishRoot, `${namespace}.json`), 'utf8')) as Record<string, string>;
      for (const key of keys) {
        expect(english, `${namespace}.${key}`).toHaveProperty(key);
        expect(spanish, `${namespace}.${key}`).toHaveProperty(key);
      }
    }
  });
});
