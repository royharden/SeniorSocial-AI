import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalAdapter } from '../../../packages/notify/src/index.ts';
import { fixture, identity, optedIn, otherOrg, otherUser, request } from '../../unit/WP-009/fixture.ts';

const composeMarkers = ['SENIORSOCIAL_LOCAL_COMPOSE', 'EMAIL_PROVIDER', 'MAILPIT_URL'] as const;
const exactComposeEnvironment = {
  SENIORSOCIAL_LOCAL_COMPOSE: 'true',
  EMAIL_PROVIDER: 'mailpit',
  MAILPIT_URL: 'http://mailpit:8025/',
} as const;

function stubComposeEnvironment(environment: Partial<Record<(typeof composeMarkers)[number], string>>) {
  for (const marker of composeMarkers) vi.stubEnv(marker, environment[marker]);
}

afterEach(() => vi.unstubAllEnvs());

describe('WP-009 authorization and disclosure', () => {
  // what_bug_this_catches: authority/voice decisions cached at claim survive revocation before sensitive render.
  it.each(['authorization', 'voice'] as const)('rechecks %s after claim before render', async control => {
    const f = fixture();
    await f.service.replace(identity, optedIn());
    const queued = await f.service.enqueue(identity, { ...request, channel: 'voice' });
    if (!('id' in queued)) throw new Error('Expected job');
    f.deps.audit.emit.mockImplementationOnce(intent => {
      f.intents.push(intent);
      if (control === 'authorization') f.deps.authorization.canNotify.mockResolvedValue(false);
      else f.deps.flags.enabled.mockResolvedValue(true);
      return Promise.resolve();
    });
    expect(await f.service.send(identity, queued.id)).toMatchObject({ status: 'suppressed' });
    expect(f.deps.renderer.body).not.toHaveBeenCalled();
    expect(f.deps.renderer.destination).not.toHaveBeenCalled();
    expect(f.deps.adapter.send).not.toHaveBeenCalled();
    expect(f.repository.jobs.get(queued.id)?.state).toBe('suppressed');
  });
  // what_bug_this_catches: a shared-device preference committed after claim is ignored by the renderer.
  it('uses a shared-phone preference committed between claim and render', async () => {
    const f = fixture();
    await f.service.replace(identity, optedIn());
    const queued = await f.service.enqueue(identity, request);
    if (!('id' in queued)) throw new Error('Expected job');
    f.deps.audit.emit.mockImplementationOnce(async intent => {
      f.intents.push(intent);
      await f.service.replace(identity, { ...optedIn(), shared_device: true });
    });
    expect(await f.service.send(identity, queued.id)).toMatchObject({ status: 'delivered' });
    expect(f.deps.renderer.body).not.toHaveBeenCalled();
    expect(f.deps.adapter.send.mock.calls[0]?.[0].body).toBe('You have a new notification. Sign in securely.');
  });
  // what_bug_this_catches: authority or voice can change during rendering yet the adapter still sends.
  it.each(['authorization', 'voice'] as const)('rechecks %s immediately before adapter invocation', async control => {
    const f = fixture();
    await f.service.replace(identity, optedIn());
    const queued = await f.service.enqueue(identity, { ...request, channel: 'voice' });
    if (!('id' in queued)) throw new Error('Expected job');
    f.deps.renderer.body.mockImplementationOnce(() => {
      if (control === 'authorization') f.deps.authorization.canNotify.mockResolvedValue(false);
      else f.deps.flags.enabled.mockResolvedValue(true);
      return Promise.resolve('private resident content');
    });
    expect(await f.service.send(identity, queued.id)).toMatchObject({ status: 'suppressed' });
    expect(f.deps.adapter.send).not.toHaveBeenCalled();
  });
  // what_bug_this_catches: knowing an id or callback code leaks protected content before authorization.
  it('denies before render or enqueue with a generic response and audit target', async () => {
    const f = fixture();
    const render = vi.fn(() => Promise.resolve('resident appointment detail'));
    expect(await f.service.disclose(identity, otherUser, otherUser, render)).toEqual({ status: 'suppressed' });
    expect(await f.service.enqueue(identity, { ...request, recipientId: otherUser })).toEqual({ status: 'suppressed' });
    expect(render).not.toHaveBeenCalled();
    expect(f.repository.jobs.size).toBe(0);
    expect(f.deps.queue.enqueue).not.toHaveBeenCalled();
    expect(JSON.stringify(f.intents)).not.toContain(otherUser);
    expect(f.intents.every(i => i.target === 'notification:restricted')).toBe(true);
  });
  // what_bug_this_catches: shared-phone suppression happens after rendering sensitive message content.
  it('does not invoke the sensitive renderer on a shared phone', async () => {
    const f = fixture();
    await f.service.replace(identity, { ...optedIn(), shared_device: true });
    const queued = await f.service.enqueue(identity, request);
    if (!('id' in queued)) throw new Error('Expected job');
    await f.service.send(identity, queued.id);
    expect(f.deps.renderer.body).not.toHaveBeenCalled();
    expect(f.deps.adapter.send.mock.calls[0]?.[0].body).toBe('You have a new notification. Sign in securely.');
  });
  // what_bug_this_catches: a previously authorized queued notice bypasses revoked membership/consent.
  it('rechecks authorization at send and returns no cross-tenant or cross-recipient job details', async () => {
    const f = fixture();
    await f.service.replace(identity, optedIn());
    const queued = await f.service.enqueue(identity, request);
    if (!('id' in queued)) throw new Error('Expected job');
    expect(await f.service.send({ ...identity, orgId: otherOrg }, queued.id)).toEqual({ status: 'suppressed' });
    expect(await f.service.send({ ...identity, userId: otherUser }, queued.id)).toEqual({ status: 'suppressed' });
    f.deps.authorization.canNotify.mockResolvedValue(false);
    expect(await f.service.send(identity, queued.id)).toMatchObject({ status: 'suppressed' });
    expect(f.deps.renderer.destination).not.toHaveBeenCalled();
  });
  // what_bug_this_catches: feature flags are checked only once, or a simulator claims real delivery.
  it('uses the independent voice flag at enqueue and send, failing closed on real-send or unavailable flags', async () => {
    const f = fixture();
    await f.service.replace(identity, optedIn());
    const queued = await f.service.enqueue(identity, { ...request, channel: 'voice' });
    if (!('id' in queued)) throw new Error('Expected job');
    expect(f.deps.flags.enabled).toHaveBeenCalledWith('notify.voice.real_send', identity.orgId);
    f.deps.flags.enabled.mockResolvedValue(true);
    expect(await f.service.send(identity, queued.id)).toMatchObject({ status: 'suppressed' });
    expect(f.deps.adapter.send).not.toHaveBeenCalled();
    f.deps.flags.enabled.mockRejectedValue(new Error('unavailable'));
    expect(await f.service.enqueue(identity, { ...request, channel: 'voice', idempotencyKey: 'second' })).toEqual({ status: 'suppressed' });
    expect(f.repository.jobs.size).toBe(1);
  });
  // what_bug_this_catches: a local adapter can be repointed at an external host or follow a redirect to one.
  it('restricts Mailpit endpoints and never sends a real recipient', async () => {
    for (const url of ['https://example.com/', 'http://localhost/', 'http://127.0.0.1@evil.invalid/', 'http://127.0.0.1/path',
      'http://127.0.0.1/?next=evil', 'http://127.0.0.1/#fragment', 'http://user:pass@127.0.0.1:8025/']) {
      expect(() => createLocalAdapter(url)).toThrow();
    }
    const transport = vi.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify({ ID: 'capture-confirmed' }))));
    const adapter = createLocalAdapter('http://127.0.0.1:8025/', transport);
    const delivery = { channel: 'email', jobId: otherUser, idempotencyKey: 'a'.repeat(64), destination: 'actual-person@private.invalid', body: 'synthetic content' } as const;
    expect(await adapter.send(delivery)).toEqual({ outcome: 'confirmed', synthetic: true });
    const options = transport.mock.calls[0]?.[1];
    expect(options?.redirect).toBe('error');
    expect(options?.body).not.toContain('actual-person');
    expect(options?.body).toContain('[SYNTHETIC]');
    transport.mockResolvedValueOnce(new Response('{}'));
    expect(await adapter.send(delivery)).toEqual({ outcome: 'ambiguous', synthetic: true });
    transport.mockRejectedValueOnce(new TypeError('redirect mode is error'));
    expect(await adapter.send(delivery)).toEqual({ outcome: 'ambiguous', synthetic: true });
  });
  // what_bug_this_catches: a production-like marker, unrelated provider marker,
  // partial conjunction or case-insensitive comparison opens Docker DNS broadly.
  it('allows Docker DNS only for the exact local-Compose Mailpit conjunction', async () => {
    stubComposeEnvironment(exactComposeEnvironment);
    expect(() => createLocalAdapter(exactComposeEnvironment.MAILPIT_URL)).not.toThrow();

    const transport = vi.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify({ ID: 'compose-capture' }))));
    const adapter = createLocalAdapter(exactComposeEnvironment.MAILPIT_URL, transport);
    expect(await adapter.send({ channel: 'email', jobId: 'synthetic-compose', idempotencyKey: 'c'.repeat(64),
      destination: 'must-not-escape@private.invalid', body: 'synthetic compose content' })).toEqual({ outcome: 'confirmed', synthetic: true });
    const target = transport.mock.calls[0]?.[0];
    expect(target).toBeInstanceOf(URL);
    expect(target instanceof URL ? target.href : '').toBe('http://mailpit:8025/api/v1/send');
    expect(transport.mock.calls[0]?.[1]?.redirect).toBe('error');
    expect(transport.mock.calls[0]?.[1]?.body).not.toContain('must-not-escape');

    for (const missing of composeMarkers) {
      const environment: Partial<Record<(typeof composeMarkers)[number], string>> = { ...exactComposeEnvironment };
      delete environment[missing];
      stubComposeEnvironment(environment);
      expect(() => createLocalAdapter(exactComposeEnvironment.MAILPIT_URL)).toThrow();
    }
    for (const [marker, wrong] of [
      ['SENIORSOCIAL_LOCAL_COMPOSE', 'TRUE'],
      ['EMAIL_PROVIDER', 'Mailpit'],
      ['MAILPIT_URL', 'http://mailpit:8025'],
    ] as const) {
      stubComposeEnvironment({ ...exactComposeEnvironment, [marker]: wrong });
      expect(() => createLocalAdapter(exactComposeEnvironment.MAILPIT_URL)).toThrow();
    }
    stubComposeEnvironment({});
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('SMS_PROVIDER', 'mailpit');
    expect(() => createLocalAdapter(exactComposeEnvironment.MAILPIT_URL)).toThrow();

    stubComposeEnvironment(exactComposeEnvironment);
    for (const url of ['http://mailpit:8025', 'http://MAILPIT:8025/', ' http://mailpit:8025/',
      'http://mailpit:8025/ ', 'http://mailpit:08025/', 'http://mailpit:8026/', 'http://mailpit/',
      'http://mailpit:8025/path', 'http://mailpit:8025/?next=loopback', 'http://mailpit:8025/#fragment',
      'http://user:pass@mailpit:8025/', 'http://127.0.0.1@mailpit:8025/', 'http://mailpit@127.0.0.1:8025/',
      'http://mailpit.invalid:8025/', 'not-a-url']) {
      expect(() => createLocalAdapter(url)).toThrow();
    }

    stubComposeEnvironment({});
    expect(() => createLocalAdapter('http://127.0.0.1:8025/')).not.toThrow();
    expect(() => createLocalAdapter('http://[::1]:8025/')).not.toThrow();
  });
});
