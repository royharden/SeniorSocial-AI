import { describe, expect, it } from 'vitest';
import { createLocalAdapter } from '../../../packages/notify/src/index.ts';

const url = process.env.MAILPIT_URL;
if (!url) throw new Error('WP-009 Mailpit integration requires an authorized local MAILPIT_URL');

describe('WP-009 local Mailpit capture', () => {
  // what_bug_this_catches: an API-compatible mock passes while the actual capture server rejects the message.
  it('confirms synthetic capture from the real server and never transmits the supplied destination', async () => {
    const adapter = createLocalAdapter(url);
    const receipt = await adapter.send({ jobId: 'synthetic-test', channel: 'email', idempotencyKey: 'b'.repeat(64),
      destination: 'never-send-to-this@private.invalid', body: 'WP-009 synthetic capture test' });
    expect(receipt).toEqual({ outcome: 'confirmed', synthetic: true });
    const response = await fetch(new URL('/api/v1/messages', url), { redirect: 'error' });
    const capture: unknown = await response.json();
    expect(JSON.stringify(capture)).toContain('capture-bbbbbbbbbbbbbbbb@example.invalid');
    expect(JSON.stringify(capture)).not.toContain('never-send-to-this');
  });
});
