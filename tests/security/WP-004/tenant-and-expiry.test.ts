import { describe, expect, it } from 'vitest';
import { AuthService, MemoryAuthStore } from '../../../packages/auth/src/index.ts';
import { isExplicitLocalMode, setDeviceCookie, trustedRequestIp } from '../../../apps/web/app/(auth)/auth/_shared.ts';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const USER_A = '11111111-1111-4111-8111-111111111101';
const PEPPER = 'wp-004-security-pepper-value';

function serviceAt(now: Date) {
  const store = new MemoryAuthStore([{
    id: USER_A,
    orgId: ORG_A,
    roles: ['senior'],
    accountState: 'active',
    isDemo: true,
  }]);
  store.addIdentifier(ORG_A, 'sms_code', '+15551234567', USER_A);
  const clock = { now };
  return { store, clock, service: new AuthService(store, { pepper: PEPPER, now: () => clock.now, exposeSimulationCredentials: true }) };
}

describe('tenant and expiry enforcement', () => {
  it('denies cross-org credential redemption and session lookup', async () => {
    // what_bug_this_catches: a digest lookup without org_id allowing one municipality to redeem another's credential/session.
    const { service } = serviceAt(new Date('2026-09-10T12:00:00Z'));
    const issued = await service.requestSmsCode(ORG_A, '+15551234567', 'browser');
    expect(await service.verify(ORG_B, 'sms_code', issued.simulationCredential!, 'browser')).toEqual({
      ok: false,
      reason: 'invalid_or_expired',
    });
    const login = await service.verify(ORG_A, 'sms_code', issued.simulationCredential!, 'browser');
    expect(login.ok).toBe(true);
    if (login.ok) expect(await service.session(ORG_B, login.value.token)).toBeNull();
  });

  it('rejects expired and replayed demo codes without creating sessions', async () => {
    // what_bug_this_catches: demo access surviving expires_at or one reviewer code being reused indefinitely.
    const { service, store, clock } = serviceAt(new Date('2026-09-10T12:00:00Z'));
    await service.bootstrapDemoAccount({ orgId: ORG_A, userId: USER_A, code: 'EXPIRED', expiresAt: new Date('2026-09-10T11:59:00Z') });
    expect(await service.loginWithDemoCode(ORG_A, 'EXPIRED')).toEqual({ ok: false, reason: 'demo_expired' });
    expect(store.sessions).toHaveLength(0);

    await service.bootstrapDemoAccount({ orgId: ORG_A, userId: USER_A, code: 'FRESH', expiresAt: new Date('2026-09-10T12:01:00Z') });
    expect((await service.loginWithDemoCode(ORG_A, 'FRESH')).ok).toBe(true);
    expect(await service.loginWithDemoCode(ORG_A, 'FRESH')).toEqual({ ok: false, reason: 'invalid_or_expired' });
    clock.now = new Date('2026-09-10T12:02:00Z');
  });

  it('keeps the recovery second phone nullable in the reversible migration', async () => {
    // what_bug_this_catches: recovery enrollment becoming mandatory through a NOT NULL database constraint.
    const migration = await import('node:fs/promises').then(fs => fs.readFile(
      new URL('../../../packages/db/migrations/0010_wp-004_auth.sql', import.meta.url),
      'utf8',
    ));
    expect(migration).toMatch(/second_phone text,/u);
    expect(migration).not.toMatch(/second_phone text NOT NULL/iu);
  });

  it('defaults custom or unset NODE_ENV to secure cookies and no local simulation mode', () => {
    // what_bug_this_catches: misspelled or custom production NODE_ENV silently disabling Secure cookies and enabling secret exposure.
    const previous = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    expect(isExplicitLocalMode()).toBe(false);
    const response = new Response();
    setDeviceCookie(response, 'nonce');
    expect(response.headers.get('set-cookie')).toContain('Secure');
    process.env.NODE_ENV = 'staging';
    expect(isExplicitLocalMode()).toBe(false);
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  });

  it('trusts only explicit local test IPs or validated configured proxy headers', () => {
    // what_bug_this_catches: direct clients spoofing X-Forwarded-For to rotate or poison durable IP limits.
    const previousNodeEnv = process.env.NODE_ENV;
    const previousTrust = process.env.AUTH_TRUST_PROXY_HEADERS;
    process.env.NODE_ENV = 'test';
    expect(trustedRequestIp(new Request('http://local.test'))).toBe('127.0.0.1');
    expect(trustedRequestIp(new Request('http://local.test', {
      headers: { 'x-auth-test-client-ip': '192.0.2.4', 'x-forwarded-for': '198.51.100.9' },
    }))).toBe('192.0.2.4');
    expect(() => trustedRequestIp(new Request('http://local.test', {
      headers: { 'x-auth-test-client-ip': 'not-an-ip' },
    }))).toThrow(/invalid local/u);

    process.env.NODE_ENV = 'staging';
    delete process.env.AUTH_TRUST_PROXY_HEADERS;
    expect(() => trustedRequestIp(new Request('https://app.test', {
      headers: { 'x-forwarded-for': '203.0.113.5' },
    }))).toThrow(/AUTH_TRUST_PROXY_HEADERS/u);
    process.env.AUTH_TRUST_PROXY_HEADERS = 'true';
    expect(() => trustedRequestIp(new Request('https://app.test'))).toThrow(/missing or invalid/u);
    expect(() => trustedRequestIp(new Request('https://app.test', {
      headers: { 'x-forwarded-for': 'spoofed' },
    }))).toThrow(/missing or invalid/u);
    expect(trustedRequestIp(new Request('https://app.test', {
      headers: { 'x-forwarded-for': '203.0.113.5, 10.0.0.1' },
    }))).toBe('203.0.113.5');

    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousTrust === undefined) delete process.env.AUTH_TRUST_PROXY_HEADERS;
    else process.env.AUTH_TRUST_PROXY_HEADERS = previousTrust;
  });
});
