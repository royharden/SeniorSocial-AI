import { afterEach, describe, expect, it, vi } from 'vitest';

const slot = Symbol.for('@seniorsocial/web.concierge.conversation-store.v1');

afterEach(() => {
  delete (globalThis as unknown as Record<PropertyKey, unknown>)[slot];
  vi.resetModules();
});

describe('WP-011 process-local store slot compatibility', () => {
  it('rejects a same-version foreign slot that does not implement the store contract', async () => {
    Object.defineProperty(globalThis, slot, {
      value: { version: 1, store: {} }, configurable: true, enumerable: false, writable: false,
    });

    await expect(import('../../../apps/web/app/api/v1/concierge/_runtime.ts'))
      .rejects.toThrow('incompatible concierge process-local store');
  }, 30_000);
});
