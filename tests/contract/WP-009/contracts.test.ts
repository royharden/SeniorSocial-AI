import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { fixture, identity, optedIn, request } from '../../unit/WP-009/fixture.ts';

describe('WP-009 immutable boundary semantics', () => {
  // what_bug_this_catches: queue bridge changes canonical names or lacks stable singleton idempotency.
  it('supplies canonical payload fields, stable singleton keys and due time on replay', async () => {
    const f = fixture();
    await f.service.replace(identity, optedIn());
    await f.service.enqueue(identity, request);
    await f.service.enqueue(identity, request);
    const [first, second] = f.deps.queue.enqueue.mock.calls;
    expect(first).toEqual(second);
    expect(first?.[0]).toBe('notify.send.sms');
    expect(Object.keys(first?.[1] ?? {}).sort()).toEqual(['idempotency_key', 'org_id', 'user_id', 'purpose', 'template', 'locale', 'params'].sort());
  });
  // what_bug_this_catches: audit intents use timestamps/ids assigned by callers, unknown properties or resident content.
  it('emits schema-compatible intents with only approved notification actions', async () => {
    const f = fixture();
    await f.service.replace(identity, optedIn());
    await f.service.enqueue(identity, request);
    const schema = JSON.parse(await readFile(new URL('../../../packages/contracts/audit-event.schema.json', import.meta.url), 'utf8')) as {
      properties: Record<string, { pattern?: string; enum?: string[] }>; required: string[];
    };
    for (const intent of f.intents) {
      expect(Object.keys(intent).every(key => key in schema.properties)).toBe(true);
      for (const key of schema.required.filter(key => key !== 'id' && key !== 'at')) expect(intent).toHaveProperty(key);
      expect(intent.action).toMatch(new RegExp(schema.properties.action?.pattern ?? '^invalid$'));
      expect(['notification.preferences_changed', 'notification.queued', 'notification.attempted', 'notification.suppressed']).toContain(intent.action);
      expect(schema.properties.outcome?.enum).toContain(intent.outcome);
      expect(intent.org_id).toBe(identity.orgId);
      expect(intent).not.toHaveProperty('at');
      expect(intent).not.toHaveProperty('id');
      expect(JSON.stringify(intent)).not.toContain('private resident content');
    }
  });
});
