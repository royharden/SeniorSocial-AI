import { describe, expect, it } from 'vitest';
import { contracts } from '../../contract/WP-002/runtime-adapter';
const id = '10000000-0000-4000-8000-000000000001';
describe('SEC-058 runtime malformed-input boundaries', () => {
  const cases: [string, unknown, unknown[]][] = [
    ['FlagPatch', { enabled: false }, [{}, { enabled: 'false' }, { enabled: 0 }, null]],
    ['IntakeSubmissionInput', { answers: {}, disclaimer_acknowledged: true, locale: 'es' }, [{ answers: [] }, { answers: {}, disclaimer_acknowledged: 'true' }, { answers: {}, disclaimer_acknowledged: true, locale: 'xx' }]],
    ['ExportRequest', { scope: ['requests'], format: 'json' }, [{ format: 'json' }, { scope: 'all', format: 'json' }, { scope: [], format: 'xml' }]],
    ['ConsentScopeSet', { scopes: [{ key: 'view_schedule', granted: true }], read_back_confirmed: true }, [{ scopes: [] }, { scopes: [{ key: 'all', granted: true }], read_back_confirmed: true }, { scopes: [{ key: 'book_rides', granted: 'true' }], read_back_confirmed: true }]],
  ];
  for (const [name, valid, malformed] of cases) {
    // what_bug_this_catches: absent fields, bad nested enums, and coerced strings crossing a public input boundary.
    it(`SEC-058 ${name} accepts a valid input and rejects malformed bodies`, async () => {
      const schema = (await contracts()).schemas[name];
      expect(schema.safeParse(valid).success).toBe(true);
      for (const input of malformed) expect(schema.safeParse(input).success).toBe(false);
    });
  }
});

// what_bug_this_catches: peer `Me.id` must not appear beside `user_id`; grafted optional fields must not become required.
it('SEC-058 Me retains one identity and its original required fields', async () => {
  const schema = (await contracts()).schemas.Me;
  const valid = { user_id: id, org_id: id, roles: ['senior'], mode: 'standard', locale: 'en' };
  expect(schema.safeParse(valid).success).toBe(true);
  expect(schema.safeParse({ ...valid, id }).success).toBe(false);
  expect(schema.safeParse({ ...valid, user_id: undefined, id }).success).toBe(false);
  for (const key of ['user_id', 'org_id', 'roles', 'mode', 'locale']) {
    expect(schema.safeParse({ ...valid, [key]: undefined }).success).toBe(false);
  }
  for (const roles of [[], ['senior', 'senior'], ['resident'], ['provider']]) expect(schema.safeParse({ ...valid, roles }).success).toBe(false);
  expect(schema.safeParse({ ...valid, roles: ['senior', 'caregiver', 'staff', 'admin', 'partner', 'support'] }).success).toBe(true);
  for (const change of [{ user_id: 'bad-uuid' }, { org_id: 'bad-uuid' }, { display_name: '' }, { display_name: 'x'.repeat(121) }, { consent_version: 0 }]) expect(schema.safeParse({ ...valid, ...change }).success).toBe(false);
});
// what_bug_this_catches: peer `Scope` must not replace `ConsentScope`; manage_events must not vanish under peer no-event delegation rules.
it('SEC-058 ConsentScope retains key/granted including manage_events', async () => {
  const schema = (await contracts()).schemas.ConsentScope;
  for (const key of ['view_schedule', 'book_rides', 'receive_alerts', 'view_assistance', 'manage_events', 'view_profile']) {
    for (const granted of [true, false]) expect(schema.safeParse({ key, granted }).success).toBe(true);
  }
  const triple = { action: 'requests.read', resource_type: 'request', resource_id: id };
  expect(schema.safeParse(triple).success).toBe(false);
  expect(schema.safeParse({ key: 'manage_events', granted: true, ...triple }).success).toBe(false);
  expect(schema.safeParse({ key: 'manage_events' }).success).toBe(false);
});
// what_bug_this_catches: grafted collection bounds disappear or peer field names replace primary export scope.
it('SEC-058 primary export scope retains bounds, uniqueness, and closed input shape', async () => {
  const schema = (await contracts()).schemas.ExportRequest;
  expect(schema.safeParse({ scope: ['profile', 'requests', 'consents', 'audit', 'proposals'], format: 'csv' }).success).toBe(true);
  for (const scope of [[], ['all'], ['requests', 'requests']]) expect(schema.safeParse({ scope, format: 'json' }).success).toBe(false);
  expect(schema.safeParse({ sections: ['requests'], format: 'json' }).success).toBe(false);
  expect(schema.safeParse({ scope: ['requests'], format: 'json', actor_context: { acting_as: 'self' } }).success).toBe(false);
});
// what_bug_this_catches: consent collection depth becomes permissive while the item schema remains correctly named.
it('SEC-058 consent collections reject empty, duplicate, over-limit and extra-field inputs', async () => {
  const schema = (await contracts()).schemas.ConsentScopeSet;
  const scope = { key: 'manage_events', granted: true };
  for (const scopes of [[], [scope, scope], Array.from({ length: 21 }, () => scope)]) expect(schema.safeParse({ scopes, read_back_confirmed: true }).success).toBe(false);
  expect(schema.safeParse({ scopes: [scope], read_back_confirmed: true, confirmed: true }).success).toBe(false);
});
// what_bug_this_catches: adopting peer event required fields breaks primary proposals, or drops mapped title length and closed envelope.
it('SEC-058 primary event proposals keep their minimal required shape', async () => {
  const schema = (await contracts()).schemas.EventProposalInput;
  const valid = { title: 'Synthetic gathering', starts_at: '2027-06-01T14:00:00Z' };
  expect(schema.safeParse(valid).success).toBe(true);
  expect(schema.safeParse({ ...valid, title: 'x'.repeat(200) }).success).toBe(true);
  for (const change of [{ title: '' }, { title: 'x'.repeat(201) }, { starts_at: 'tomorrow' }, { expected_version: 0 }]) expect(schema.safeParse({ ...valid, ...change }).success).toBe(false);
});
// what_bug_this_catches: closed intake envelope accidentally closes optional answers or promotes unrelated peer fields to required.
it('SEC-058 intake keeps partial answers open but rejects unknown envelope fields', async () => {
  const schema = (await contracts()).schemas.IntakeSubmissionInput;
  expect(schema.safeParse({ answers: {}, disclaimer_acknowledged: true }).success).toBe(true);
  expect(schema.safeParse({ answers: { optional_note: 'Synthetic information' }, disclaimer_acknowledged: true }).success).toBe(true);
  expect(schema.safeParse({ answers: {}, disclaimer_acknowledged: true, confirmed: true }).success).toBe(false);
});
