import { describe, expect, it, vi } from 'vitest';
import {
  type AssistanceRequest,
  type AssistanceService,
  type CreateInput,
  type Identity,
} from '../../../packages/assistance/src/index.ts';
import {
  createPostgresConciergeAssistanceAdapter,
  isCanonicalAssistanceEncryptionKey,
} from '../../../apps/web/app/api/v1/concierge/_runtime.ts';

const orgId = '88888888-8888-4888-8888-888888888888';
const userId = '88888888-8888-4888-8888-888888888801';
const identity: Identity = { orgId, userId, roles: ['senior'] };
const input = {
  orgId,
  actorId: userId,
  onBehalfOf: '88888888-8888-4888-8888-888888888899',
  summary: 'Need meal delivery information',
  locale: 'en' as const,
  idempotencyKey: 'stable-concierge-handoff-key',
};

function request(): AssistanceRequest {
  return {
    id: '88888888-8888-4888-8888-888888888802', orgId, requesterId: userId,
    summary: input.summary, locale: 'en', triageCategory: 'food', triageSource: 'rules',
    state: 'pending_unowned', ownerId: null, afterHours: false,
    slaDueAt: new Date('2026-09-10T18:00:00.000Z'), slaBreachedAt: null,
    createdAt: new Date('2026-09-10T17:00:00.000Z'),
  };
}

describe('WP-011 assistance composition authority boundaries', () => {
  it.each([
    ['organization', { ...identity, orgId: '99999999-9999-4999-8999-999999999999' }],
    ['actor', { ...identity, userId: '99999999-9999-4999-8999-999999999901' }],
  ] as const)('rejects a %s mismatch before opening the database service', async (_name, trustedIdentity) => {
    const run = vi.fn();
    const adapter = createPostgresConciergeAssistanceAdapter({
      trustedIdentity: () => trustedIdentity,
      encryptionKey: () => Buffer.alloc(32).toString('base64'),
      timeZone: () => 'UTC',
      run,
    });
    await expect(adapter.create(input)).rejects.toThrow('trusted concierge identity is required');
    expect(run).not.toHaveBeenCalled();
  });

  it('uses only the trusted identity and treats onBehalfOf as non-authoritative data', async () => {
    const create = vi.fn((mapped: Identity, createInput: CreateInput) => {
      expect(mapped).toEqual(identity);
      expect(mapped.userId).not.toBe(input.onBehalfOf);
      expect(createInput).not.toHaveProperty('onBehalfOf');
      return Promise.resolve(request());
    });
    const adapter = createPostgresConciergeAssistanceAdapter({
      trustedIdentity: () => identity,
      encryptionKey: () => Buffer.alloc(32).toString('base64'),
      timeZone: () => 'UTC',
      run: (
        _configuration: { readonly encryptionKey: string; readonly timeZone: string },
        work: (service: Pick<AssistanceService, 'create'>) => Promise<AssistanceRequest>,
      ) => work({ create }),
    });
    await adapter.create(input);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[1]).not.toHaveProperty('onBehalfOf');
  });

  it.each([
    ['missing encryption', undefined, (): string => 'UTC', new Error('ASSISTANCE_ENCRYPTION_KEY is required')],
    ['malformed configuration', Buffer.alloc(32).toString('base64'), (): string => { throw new Error('invalid city timezone'); }, new Error('invalid city timezone')],
  ] as const)('fails truthfully for %s', async (_name, key, timeZone, expected) => {
    const adapter = createPostgresConciergeAssistanceAdapter({
      trustedIdentity: () => identity,
      encryptionKey: () => key,
      timeZone,
      run: (): Promise<AssistanceRequest> => Promise.reject(new Error('unexpected runner call')),
    });
    await expect(adapter.create(input)).rejects.toThrow(expected.message);
  });

  it.each([
    ['invalid alphabet', '!!!!'],
    ['inserted junk', `${Buffer.alloc(16, 1).toString('base64')}####${Buffer.alloc(16, 2).toString('base64')}`],
    ['misplaced padding', `=${Buffer.alloc(32, 3).toString('base64').slice(1)}`],
    ['excess padding', `${Buffer.alloc(32, 4).toString('base64')}=`],
    ['trailing junk', `${Buffer.alloc(32, 5).toString('base64')}junk`],
    ['wrong decoded length', Buffer.alloc(31, 6).toString('base64')],
  ])('rejects %s in an encryption key before opening WP-014', async (_name, malformed) => {
    const run = vi.fn<() => Promise<AssistanceRequest>>();
    const adapter = createPostgresConciergeAssistanceAdapter({
      trustedIdentity: () => identity,
      encryptionKey: () => malformed,
      timeZone: () => 'UTC',
      run,
    });
    await expect(adapter.create(input)).rejects.toThrow('ASSISTANCE_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
    expect(run).not.toHaveBeenCalled();
  });

  it('accepts and preserves a canonical 32-byte base64 environment key', async () => {
    const key = Buffer.alloc(32, 7).toString('base64');
    const previous = process.env.ASSISTANCE_ENCRYPTION_KEY;
    process.env.ASSISTANCE_ENCRYPTION_KEY = key;
    const run = vi.fn((configuration: { readonly encryptionKey: string }) => {
      expect(configuration.encryptionKey).toBe(key);
      return Promise.resolve(request());
    });
    const adapter = createPostgresConciergeAssistanceAdapter({
      trustedIdentity: () => identity,
      timeZone: () => 'UTC',
      run,
    });
    try {
      await expect(adapter.create(input)).resolves.toMatchObject({ id: request().id });
      expect(isCanonicalAssistanceEncryptionKey(key)).toBe(true);
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      if (previous === undefined) delete process.env.ASSISTANCE_ENCRYPTION_KEY;
      else process.env.ASSISTANCE_ENCRYPTION_KEY = previous;
    }
  });

  it('does not mask database failures', async () => {
    const adapter = createPostgresConciergeAssistanceAdapter({
      trustedIdentity: () => identity,
      encryptionKey: () => Buffer.alloc(32).toString('base64'),
      timeZone: () => 'UTC',
      run: (): Promise<AssistanceRequest> => Promise.reject(new Error('database unavailable')),
    });
    await expect(adapter.create(input)).rejects.toThrow('database unavailable');
  });
});
