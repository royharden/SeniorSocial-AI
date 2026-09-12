import { expect, test } from '@playwright/test';
import { AuthService, MemoryAuthStore } from '../../../packages/auth/src/index.ts';

test('@smoke a resident can complete local SMS login and end the server session', async () => {
  // what_bug_this_catches: a route-shaped happy path that issues a cookie but cannot retrieve or revoke its backing session.
  const orgId = '11111111-1111-4111-8111-111111111111';
  const userId = '11111111-1111-4111-8111-111111111101';
  const store = new MemoryAuthStore([{
    id: userId,
    orgId,
    roles: ['senior'],
    accountState: 'active',
    isDemo: false,
  }]);
  store.addIdentifier(orgId, 'sms_code', '+15551234567', userId);
  const service = new AuthService(store, {
    pepper: 'wp-004-e2e-pepper-value-value',
    exposeSimulationCredentials: true,
  });

  const issued = await service.requestSmsCode(orgId, '+15551234567', 'reviewer-browser');
  const login = await service.verify(orgId, 'sms_code', issued.simulationCredential!, 'reviewer-browser');
  expect(login.ok).toBe(true);
  if (!login.ok) return;
  expect(await service.session(orgId, login.value.token)).toMatchObject({ userId, orgId, roles: ['senior'] });
  await service.logout(orgId, login.value.token);
  expect(await service.session(orgId, login.value.token)).toBeNull();
});
