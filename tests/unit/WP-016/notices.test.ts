import { describe, expect, it } from 'vitest';
import type { TenantTransaction } from '../../../packages/db/src/index.ts';
import { textInput, wp009Notices } from '../../../packages/messaging/src/index.ts';

describe('WP-016 minimal message notices', () => {
  async function enqueue(preferences: unknown) {
    const statements: { sql: string; values: unknown[] }[] = [];
    const sql = ((template: TemplateStringsArray, ...values: unknown[]) => {
      const query = template.join('?'); statements.push({ sql: query, values });
      if (query.includes('select preferences')) return Promise.resolve(preferences ? [{ preferences }] : []);
      if (query.includes('insert into notification_outbox')) return Promise.resolve([{ id: 'notice-id' }]);
      return Promise.resolve([]);
    }) as unknown as TenantTransaction;
    await wp009Notices.enqueue(sql, { orgId: 'org', actorId: 'sender', recipientId: 'recipient', conversationId: '10000000-0000-4000-8000-000000000001', messageId: 'native-id', at: new Date('2026-09-10T23:00:00Z') });
    return statements;
  }
  const preferences = { mode: 'standard', locale: 'en', channels: { message: { email: true, sms: false, voice: false } }, quiet_hours: {}, no_outbound: false, shared_device: false };
  it('defaults to no outbound and respects explicit purpose/channel refusal', async () => {
    for (const input of [undefined, { ...preferences, no_outbound: true }, { ...preferences, channels: { event_reminder: { email: true } } }]) {
      expect((await enqueue(input)).filter(query => query.sql.includes('insert into notification_outbox'))).toHaveLength(0);
    }
  });
  it('schedules only opted-in channels after quiet hours with no body or conversation disclosure', async () => {
    const statements = await enqueue({ ...preferences, quiet_hours: { start: '22:00', end: '07:00', timezone: 'UTC' } });
    const inserts = statements.filter(query => query.sql.includes('insert into notification_outbox'));
    expect(inserts).toHaveLength(1);
    const values = inserts[0]!.values;
    expect(values).toContain('email'); expect(values).toContain('sender');
    expect(values.find(value => value instanceof Date)).toEqual(new Date('2026-09-11T07:00:00Z'));
    const payload: unknown = JSON.parse(values.find(value => typeof value === 'string' && value.startsWith('{')) as string);
    expect(payload).toMatchObject({ purpose: 'message', params: {} });
    expect(JSON.stringify(payload)).not.toContain('native-id');
  });
  it('rejects malformed, blank, NUL and oversized native input without echoing it', () => {
    for (const value of [null, {}, '', ' ', '\0', 'x'.repeat(4001)]) expect(() => textInput(value, 4000)).toThrow('invalid_input');
    expect(textInput('<script>inert text</script>', 4000)).toBe('<script>inert text</script>');
    expect(textInput(undefined, 2000, true)).toBe('');
  });
});
