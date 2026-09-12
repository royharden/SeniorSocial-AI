import { afterEach, describe, expect, it } from 'vitest';
import { adminServiceContext, publicServiceContext, ServiceContextUnavailable, ServiceForbidden } from '../../../apps/web/app/api/v1/services/_context';

const original = {
  orgId: process.env.SENIORSOCIAL_ORG_ID,
};
afterEach(() => {
  for (const [name, value] of [
    ['SENIORSOCIAL_ORG_ID', original.orgId],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('WP-010 server-resolved context', () => {
  it('fails closed instead of inventing a tenant or actor', async () => {
    delete process.env.SENIORSOCIAL_ORG_ID;
    expect(publicServiceContext).toThrow(ServiceContextUnavailable);
    await expect(adminServiceContext(new Request('http://local/admin'))).rejects.toBeInstanceOf(ServiceContextUnavailable);
  });

  it('requires an authenticated session for administration', async () => {
    process.env.SENIORSOCIAL_ORG_ID = '11111111-1111-4111-8111-111111111111';
    await expect(adminServiceContext(new Request('http://local/admin'))).rejects.toBeInstanceOf(ServiceForbidden);
  });
});
