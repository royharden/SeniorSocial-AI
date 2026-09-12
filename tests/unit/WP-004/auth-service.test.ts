import { describe, expect, it } from 'vitest';
import {
  AuthService,
  MemoryAuthStore,
  RateLimitError,
  assertDedicatedAuthTestDatabase,
  validateCanonicalAuthInput,
} from '../../../packages/auth/src/index.ts';

const PEPPER = 'wp-004-test-pepper-is-not-a-secret';
const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '11111111-1111-4111-8111-111111111101';

function setup(now: Date) {
  const store = new MemoryAuthStore([{
    id: USER,
    orgId: ORG,
    roles: ['senior'],
    accountState: 'active',
    isDemo: false,
  }]);
  store.addIdentifier(ORG, 'magic_link', 'mara@example.invalid', USER);
  const clock = { now };
  return {
    store,
    clock,
    service: new AuthService(store, { pepper: PEPPER, now: () => clock.now, exposeSimulationCredentials: true }),
  };
}

describe('AuthService lifecycle', () => {
  it('does not enumerate registered identifiers in public request responses', async () => {
    // what_bug_this_catches: request endpoints disclosing account existence through a different response body or simulator secret.
    const store = new MemoryAuthStore([{
      id: USER,
      orgId: ORG,
      roles: ['senior'],
      accountState: 'active',
      isDemo: false,
    }]);
    store.addIdentifier(ORG, 'magic_link', 'mara@example.invalid', USER);
    const service = new AuthService(store, { pepper: PEPPER, exposeSimulationCredentials: false });

    const registered = await service.requestMagicLink(ORG, 'mara@example.invalid', 'registered-browser');
    const unknown = await service.requestMagicLink(ORG, 'unknown@example.invalid', 'unknown-browser');

    expect(registered).toEqual({ accepted: true });
    expect(unknown).toEqual(registered);
    expect(registered).not.toHaveProperty('simulationCredential');
  });

  it('consumes a browser-bound magic link once and logout revokes its session', async () => {
    // what_bug_this_catches: forwarded/replayed links and a logout that only clears the browser cookie.
    const { service } = setup(new Date('2026-09-10T12:00:00Z'));
    const issued = await service.requestMagicLink(ORG, 'mara@example.invalid', 'original-browser');
    const wrongBrowser = await service.verify(ORG, 'magic_link', issued.simulationCredential!, 'other-browser');
    expect(wrongBrowser).toEqual({ ok: false, reason: 'wrong_device' });
    const login = await service.verify(ORG, 'magic_link', issued.simulationCredential!, 'original-browser');
    expect(login.ok).toBe(true);
    if (!login.ok) return;
    expect(await service.verify(ORG, 'magic_link', issued.simulationCredential!, 'original-browser')).toEqual({
      ok: false,
      reason: 'invalid_or_expired',
    });
    expect(await service.session(ORG, login.value.token)).not.toBeNull();
    expect(await service.logout(ORG, login.value.token)).toBe(true);
    expect(await service.session(ORG, login.value.token)).toBeNull();
  });

  it('rejects expired credentials server-side', async () => {
    // what_bug_this_catches: a UI-only timer allowing an old credential to establish a session.
    const { service, clock } = setup(new Date('2026-09-10T12:00:00Z'));
    const issued = await service.requestMagicLink(ORG, 'mara@example.invalid', 'browser');
    clock.now = new Date('2026-09-10T12:16:00Z');
    expect(await service.verify(ORG, 'magic_link', issued.simulationCredential!, 'browser')).toEqual({
      ok: false,
      reason: 'invalid_or_expired',
    });
  });

  it('kills a credential after five failed attempts and permits omitted verify method', async () => {
    // what_bug_this_catches: unlimited guessing or a canonical optional method being made mandatory by implementation.
    const { service } = setup(new Date('2026-09-10T12:00:00Z'));
    const issued = await service.requestMagicLink(ORG, 'mara@example.invalid', 'browser');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await service.verify(ORG, undefined, `wrong-${attempt}`, 'browser')).ok).toBe(false);
    }
    expect((await service.verify(ORG, undefined, issued.simulationCredential!, 'browser')).ok).toBe(false);
  });

  it('returns deterministic rate-limit decisions without disclosing account existence', async () => {
    // what_bug_this_catches: a non-atomic or account-dependent request throttle leaking registration state.
    const { service } = setup(new Date('2026-09-10T12:00:00Z'));
    for (let request = 0; request < 3; request += 1) {
      await expect(service.requestMagicLink(ORG, 'mara@example.invalid', `browser-${request}`, '10.0.0.1')).resolves.toMatchObject({ accepted: true });
    }
    await expect(service.requestMagicLink(ORG, 'mara@example.invalid', 'browser-4', '10.0.0.1'))
      .rejects.toBeInstanceOf(RateLimitError);
  });

  it('keeps an IP cap across verification cookie rotation', async () => {
    // what_bug_this_catches: an attacker rotating the device cookie to reset the only verification throttle.
    const { service } = setup(new Date('2026-09-10T12:00:00Z'));
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const result = await service.verify(ORG, undefined, 'wrong', `rotated-cookie-${attempt}`, '203.0.113.4');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).not.toBe('rate_limited');
    }
    expect(await service.verify(ORG, undefined, 'wrong', 'rotated-cookie-31', '203.0.113.4')).toMatchObject({
      ok: false,
      reason: 'rate_limited',
    });
  });

  it('rate-limits demo codes independently by device and trusted IP', async () => {
    // what_bug_this_catches: the durable limiter covering passwordless endpoints but leaving demo-code guessing unbounded.
    const deviceLimited = setup(new Date('2026-09-10T12:00:00Z')).service;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await deviceLimited.loginWithDemoCode(ORG, 'wrong', 'same-device', `198.51.100.${attempt + 1}`)).ok).toBe(false);
    }
    expect(await deviceLimited.loginWithDemoCode(ORG, 'wrong', 'same-device', '198.51.100.10')).toMatchObject({
      ok: false,
      reason: 'rate_limited',
    });

    const ipLimited = setup(new Date('2026-09-10T12:00:00Z')).service;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect((await ipLimited.loginWithDemoCode(ORG, 'wrong', `device-${attempt}`, '198.51.100.20')).ok).toBe(false);
    }
    expect(await ipLimited.loginWithDemoCode(ORG, 'wrong', 'device-21', '198.51.100.20')).toMatchObject({
      ok: false,
      reason: 'rate_limited',
    });
  });

  it('uses the canonical WP-002 request schemas, including optional VerifyRequest.method', () => {
    // what_bug_this_catches: route-local validation drifting from the generated contract.
    expect(validateCanonicalAuthInput('MagicLinkRequest', { email: 'bad' }).success).toBe(false);
    expect(validateCanonicalAuthInput('MagicLinkRequest', { email: 'ok@example.invalid' }).success).toBe(true);
    expect(validateCanonicalAuthInput('VerifyRequest', { credential: 'token' }).success).toBe(true);
    expect(validateCanonicalAuthInput('VerifyRequest', { credential: 'token', method: 'password' }).success).toBe(false);
  });

  it('fails closed unless PostgreSQL tests name and opt into a dedicated test database', () => {
    // what_bug_this_catches: destructive migration tests accidentally targeting a developer or shared database.
    const previous = process.env.AUTH_TEST_DB_ALLOWED;
    delete process.env.AUTH_TEST_DB_ALLOWED;
    expect(() => assertDedicatedAuthTestDatabase('postgres://localhost/seniorsocial')).toThrow(/refusing/);
    process.env.AUTH_TEST_DB_ALLOWED = 'true';
    expect(assertDedicatedAuthTestDatabase('postgres://localhost/seniorsocial_test')).toContain('seniorsocial_test');
    if (previous === undefined) delete process.env.AUTH_TEST_DB_ALLOWED;
    else process.env.AUTH_TEST_DB_ALLOWED = previous;
  });
});
