import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { caregiver, change, fixture, orgId, otherOrg, resident, resourceId } from '../../unit/WP-005/fixture.ts';

describe('WP-005 / WP-006 canonical audit contract', () => {
  // what_bug_this_catches: policy invents fields/actions or drops attribution/reasons at the audit boundary.
  it('grant/revoke/denial intents materialize into valid canonical events', async () => {
    const f = fixture();
    await f.policy.grant(change('book_rides', 0));
    await f.policy.revoke(change('book_rides', 1));
    await f.policy.authorize({ actor: caregiver, decisionActor: resident, orgId,
      action: 'book', resource: { id: resourceId, orgId: otherOrg, residentId: resident.id, kind: 'ride' } });
    const schema = JSON.parse(readFileSync(new URL('../../../packages/contracts/audit-event.schema.json', import.meta.url), 'utf8')) as Record<string, unknown>;
    const self = fixture();
    await self.policy.grant({ ...change('book_rides', 0), actor: resident });
    await self.policy.revoke({ ...change('book_rides', 1), actor: resident });
    expect(self.intents.map(intent => intent.on_behalf_of)).toEqual([null, null]);
    const events = [...f.intents, ...self.intents].map(intent => ({ ...intent, id: resourceId, at: '2026-09-10T19:00:00Z' }));
    // Python's installed jsonschema validates the actual Draft 2020-12 contract,
    // including formats. No translated or weakened schema is used.
    const result = execFileSync(process.env.PYTHON ?? 'python', ['-c',
      'import json,sys; from jsonschema import Draft202012Validator,FormatChecker; d=json.load(sys.stdin); v=Draft202012Validator(d["schema"],format_checker=FormatChecker()); [v.validate(e) for e in d["events"]]; print("valid")'],
    { input: JSON.stringify({ schema, events }), encoding: 'utf8' });
    expect(result.trim()).toBe('valid');
    expect(f.intents.map(i => i.action)).toEqual(['consent.granted', 'consent.revoked', 'caregiver.denied']);
    const vocabulary = Object.values(schema['x-actions'] as Record<string, string[]>).flat();
    for (const intent of f.intents) expect(vocabulary).toContain(intent.action);
    expect(events[0]).toMatchObject({ actor: `user:${change('book_rides', 0).actor.id}`, on_behalf_of: `user:${resident.id}` });
    expect(f.intents[2]).toMatchObject({ target: 'policy:authorization', on_behalf_of: null, reason: 'policy_denied' });
  });
});
