import { describe, expect, it } from 'vitest';
import { AuthService, MemoryAuthStore, authRoleValues } from '../../../packages/auth/src/index.ts';

const PEPPER = 'wp-004-role-matrix-pepper-value';
const ORG = '11111111-1111-4111-8111-111111111111';

describe('all canonical roles can establish sessions', () => {
  for (const [index, role] of authRoleValues.entries()) {
    const userId = `11111111-1111-4111-8111-${String(index + 1).padStart(12, '0')}`;
    const email = `${role}@example.invalid`;
    const phone = `+15550000${String(index).padStart(2, '0')}`;

    it(`${role}: magic link, SMS simulator, and demo code are integrated`, async () => {
      // what_bug_this_catches: a canonical role missing from one bootstrap/login path or losing its role in session lookup.
      const store = new MemoryAuthStore([{
        id: userId,
        orgId: ORG,
        roles: [role],
        accountState: 'active',
        isDemo: true,
      }]);
      store.addIdentifier(ORG, 'magic_link', email, userId);
      store.addIdentifier(ORG, 'sms_code', phone, userId);
      const service = new AuthService(store, { pepper: PEPPER, exposeSimulationCredentials: true });

      const magic = await service.requestMagicLink(ORG, email, `magic-${role}`);
      const magicSession = await service.verify(ORG, 'magic_link', magic.simulationCredential!, `magic-${role}`);
      expect(magicSession.ok && magicSession.value.roles).toEqual([role]);

      const sms = await service.requestSmsCode(ORG, phone, `sms-${role}`);
      expect(sms.simulationCredential).toMatch(/^\d{6}$/u);
      const smsSession = await service.verify(ORG, 'sms_code', sms.simulationCredential!, `sms-${role}`);
      expect(smsSession.ok && smsSession.value.roles).toEqual([role]);

      await service.bootstrapDemoAccount({
        orgId: ORG,
        userId,
        code: `DEMO-${role}`,
        expiresAt: new Date(Date.now() + 60_000),
      });
      const demoSession = await service.loginWithDemoCode(ORG, `DEMO-${role}`);
      expect(demoSession.ok && demoSession.value.roles).toEqual([role]);
      if (demoSession.ok) expect((await service.session(ORG, demoSession.value.token))?.isDemo).toBe(true);
    });
  }
});
