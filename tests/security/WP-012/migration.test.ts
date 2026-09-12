import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('WP-012 storage controls', () => {
  it('forces tenant isolation and durable reminder idempotency in the migration', () => {
    const source = readFileSync(new URL('../../../packages/db/migrations/0060_wp-012_events.sql', import.meta.url), 'utf8');
    expect(source).toContain('FORCE ROW LEVEL SECURITY');
    expect(source).toContain("UNIQUE (org_id, event_id, user_id)");
    expect(source).toContain('UNIQUE (org_id, idempotency_key)');
    expect(source).toContain('CREATE TABLE event_reminder_intents');
    expect(source).toContain("purpose text NOT NULL CHECK (purpose = 'event_reminder')");
    expect(source.match(/time_zone text NOT NULL/g)).toHaveLength(2);
    expect(source.indexOf('event_reminder_intents')).toBeGreaterThan(source.indexOf('event_rsvps'));
  });
});
