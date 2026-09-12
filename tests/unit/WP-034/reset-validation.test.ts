import { expect, it } from 'vitest';
import { DEMO_ADMIN_ID, DEMO_ORG_ID, DEMO_RESET_VERSION, expectedDemoCounts } from '../../../packages/db/seed/demo/data.ts';
import { resetDemoFixture } from '../../../packages/db/seed/demo/reset.ts';
import { AesGcmNarrativeCodec } from '../../../packages/assistance/src/crypto.ts';

const encryptionKey = Buffer.alloc(32, 34).toString('base64');
const codec = new AesGcmNarrativeCodec(encryptionKey);

it.each(['count', 'version'])('rolls back %s drift before the transaction can commit', async drift => {
  // what_bug_this_catches: validation after begin resolves leaves corrupt state committed.
  let committed = false;
  const client = {
    begin: async (callback: (tx: (strings: TemplateStringsArray) => Promise<unknown[]>) => Promise<unknown>) => {
      const result = await callback((strings: TemplateStringsArray) => {
        const statement = strings.join('');
        if (statement.includes('seniorsocial_reset_demo')) return Promise.resolve([{ result: {
          fixture_version: drift === 'version' ? 'wrong' : DEMO_RESET_VERSION,
          counts: expectedDemoCounts,
        } }]);
        if (statement.includes('(select count(*)::int from users')) {
          return Promise.resolve([{ ...expectedDemoCounts, users: drift === 'count' ? 7 : 6 }]);
        }
        return Promise.resolve([]);
      });
      committed = true;
      return result;
    },
  };
  await expect(resetDemoFixture(client as never, { orgId: DEMO_ORG_ID, userId: DEMO_ADMIN_ID }, 'synthetic-pepper-only', codec)).rejects.toThrow('drift');
  expect(committed).toBe(false);
});

it.each([undefined, '', 'not-a-valid-32-byte-key'])('rejects missing or invalid assistance encryption config before opening a transaction', async key => {
  // what_bug_this_catches: reset deleting the fixture before discovering it cannot encrypt the seeded assistance narrative.
  let began = false;
  const client = { begin: () => { began = true; return Promise.resolve(); } };
  const invoke = () => {
    const invalidCodec = key === undefined ? undefined : new AesGcmNarrativeCodec(key);
    return resetDemoFixture(
      client as never,
      { orgId: DEMO_ORG_ID, userId: DEMO_ADMIN_ID },
      'synthetic-pepper-only',
      invalidCodec as never,
    );
  };
  await expect(Promise.resolve().then(invoke)).rejects.toThrow('ASSISTANCE_ENCRYPTION_KEY');
  expect(began).toBe(false);
});

it('repairs the exact assistance row emitted by an already-applied legacy reset function', async () => {
  // what_bug_this_catches: deployed 0180 functions retaining the placeholder row and colliding with a second fixed-id insert.
  const statements: string[] = [];
  const client = {
    begin: async (callback: (tx: (strings: TemplateStringsArray) => Promise<unknown[]>) => Promise<unknown>) => callback((strings: TemplateStringsArray) => {
      const statement = strings.join('');
      statements.push(statement);
      if (statement.includes('seniorsocial_reset_demo')) return Promise.resolve([{ result: {
        fixture_version: DEMO_RESET_VERSION, counts: expectedDemoCounts,
      } }]);
      if (statement.includes('select exists')) return Promise.resolve([{ exists: true }]);
      if (statement.includes('(select count(*)::int from users')) return Promise.resolve([expectedDemoCounts]);
      return Promise.resolve([]);
    }),
  };
  await resetDemoFixture(client as never, { orgId: DEMO_ORG_ID, userId: DEMO_ADMIN_ID }, 'synthetic-pepper-only', codec);
  const source = statements.join('\n');
  expect(source).toContain('disable trigger assistance_requests_identity_immutable');
  expect(source).toContain('update assistance_requests set summary_ciphertext=');
  expect(source).toContain('enable trigger assistance_requests_identity_immutable');
  expect(source).not.toContain('insert into assistance_transitions');
  expect(source).not.toContain('insert into sla_clocks');
});
