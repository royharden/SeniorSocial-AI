import { describe, expect, it, vi } from 'vitest';
import { createWorkerHealth, type WorkerHealth } from '../../../packages/worker/src/health.ts';
import { WorkerLifecycle } from '../../../packages/worker/src/lifecycle.ts';

function fakeHealth(events: string[]): WorkerHealth {
  return {
    listen: vi.fn(() => { events.push('health:listen'); return Promise.resolve(); }),
    port: () => null,
    ready: vi.fn(() => { events.push('health:ready'); }),
    stopping: vi.fn(() => { events.push('health:stopping'); }),
    failed: vi.fn(() => { events.push('health:failed'); }),
    close: vi.fn(() => { events.push('health:close'); return Promise.resolve(); }),
  };
}

function fixture(overrides: Partial<ConstructorParameters<typeof WorkerLifecycle>[0]> = {}) {
  const events: string[] = [];
  const dependencies: ConstructorParameters<typeof WorkerLifecycle>[0] = {
    health: fakeHealth(events),
    boss: {
      start: vi.fn(() => { events.push('boss:start'); return Promise.resolve(); }),
      stop: vi.fn(() => { events.push('boss:stop'); return Promise.resolve(); }),
    },
    database: { end: vi.fn(() => { events.push('database:end'); return Promise.resolve(); }) },
    registerNotificationConsumers: vi.fn(() => { events.push('notifications:registered'); return Promise.resolve(); }),
    registerPrintConsumer: vi.fn(() => { events.push('print:registered'); return Promise.resolve(); }),
    recover: vi.fn(() => { events.push('recovery'); return Promise.resolve(); }),
    recoveryIntervalMs: 60_000,
    ...overrides,
  };
  return { events, dependencies, lifecycle: new WorkerLifecycle(dependencies) };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('WP-001 real worker lifecycle', () => {
  // what_bug_this_catches: Compose reports a healthy worker before every real queue consumer exists.
  it('marks readiness only after pg-boss and both consumer groups register', async () => {
    const { lifecycle, events } = fixture();
    await lifecycle.start();
    expect(events).toEqual([
      'health:listen', 'boss:start', 'notifications:registered', 'print:registered',
      'health:ready', 'recovery',
    ]);
    await lifecycle.shutdown();
  });

  // what_bug_this_catches: a registration exception leaves a health-only process green and restart-proof.
  it('fails closed and releases started resources when consumer startup fails', async () => {
    const { lifecycle, dependencies, events } = fixture();
    dependencies.registerPrintConsumer = vi.fn(() => { events.push('print:failed'); return Promise.reject(new Error('registration failed')); });
    await expect(lifecycle.start()).rejects.toThrow('registration failed');
    expect(dependencies.health.ready).not.toHaveBeenCalled();
    expect(events).toEqual([
      'health:listen', 'boss:start', 'notifications:registered', 'print:failed',
      'health:failed', 'boss:stop', 'database:end', 'health:close',
    ]);
  });

  // what_bug_this_catches: SIGTERM during boss.start lets startup resume after cleanup and orphan a boss instance.
  it('serializes shutdown requested while pg-boss is starting', async () => {
    const gate = deferred();
    const { lifecycle, dependencies } = fixture();
    dependencies.boss.start = vi.fn(() => gate.promise);
    const starting = lifecycle.start();
    await vi.waitFor(() => expect(dependencies.boss.start).toHaveBeenCalledOnce());
    const stopping = lifecycle.shutdown();
    gate.resolve();
    await expect(starting).rejects.toThrow('stopped during startup');
    await stopping;
    expect(dependencies.registerNotificationConsumers).not.toHaveBeenCalled();
    expect(dependencies.registerPrintConsumer).not.toHaveBeenCalled();
    expect(dependencies.boss.stop).toHaveBeenCalledOnce();
    expect(dependencies.database.end).toHaveBeenCalledOnce();
    expect(dependencies.health.close).toHaveBeenCalledOnce();
  });

  // what_bug_this_catches: a pg-boss error during start leaves HTTP failed but still logs worker ready.
  it('fails startup when the queue emits an error while pg-boss is starting', async () => {
    const gate = deferred();
    const { lifecycle, dependencies } = fixture();
    dependencies.boss.start = vi.fn(() => gate.promise);
    const starting = lifecycle.start();
    await vi.waitFor(() => expect(dependencies.boss.start).toHaveBeenCalledOnce());
    lifecycle.queueFailed();
    gate.resolve();
    await expect(starting).rejects.toThrow('queue failed during startup');
    expect(dependencies.health.ready).not.toHaveBeenCalled();
    expect(dependencies.health.failed).toHaveBeenCalledOnce();
    expect(dependencies.boss.stop).toHaveBeenCalledOnce();
    expect(dependencies.database.end).toHaveBeenCalledOnce();
    expect(dependencies.health.close).toHaveBeenCalledOnce();
  });

  // what_bug_this_catches: SIGTERM while the health listener binds allows queue startup after teardown begins.
  it('serializes shutdown requested while health is binding', async () => {
    const gate = deferred();
    const { lifecycle, dependencies } = fixture();
    dependencies.health.listen = vi.fn(() => gate.promise);
    const starting = lifecycle.start();
    await vi.waitFor(() => expect(dependencies.health.listen).toHaveBeenCalledOnce());
    const stopping = lifecycle.shutdown();
    gate.resolve();
    await expect(starting).rejects.toThrow('stopped during startup');
    await stopping;
    expect(dependencies.boss.start).not.toHaveBeenCalled();
    expect(dependencies.database.end).toHaveBeenCalledOnce();
    expect(dependencies.health.close).toHaveBeenCalledOnce();
  });

  // what_bug_this_catches: SIGTERM during notification registration continues into print registration after teardown.
  it('serializes shutdown requested while consumers are registering', async () => {
    const gate = deferred();
    const { lifecycle, dependencies } = fixture();
    dependencies.registerNotificationConsumers = vi.fn(() => gate.promise);
    const starting = lifecycle.start();
    await vi.waitFor(() => expect(dependencies.registerNotificationConsumers).toHaveBeenCalledOnce());
    const stopping = lifecycle.shutdown();
    gate.resolve();
    await expect(starting).rejects.toThrow('stopped during startup');
    await stopping;
    expect(dependencies.registerPrintConsumer).not.toHaveBeenCalled();
    expect(dependencies.boss.stop).toHaveBeenCalledOnce();
    expect(dependencies.database.end).toHaveBeenCalledOnce();
    expect(dependencies.health.close).toHaveBeenCalledOnce();
  });

  // what_bug_this_catches: SIGINT during print registration marks ready or leaves queue resources open.
  it('serializes shutdown requested while the print consumer is registering', async () => {
    const gate = deferred();
    const { lifecycle, dependencies } = fixture();
    dependencies.registerPrintConsumer = vi.fn(() => gate.promise);
    const starting = lifecycle.start();
    await vi.waitFor(() => expect(dependencies.registerPrintConsumer).toHaveBeenCalledOnce());
    const stopping = lifecycle.shutdown();
    gate.resolve();
    await expect(starting).rejects.toThrow('stopped during startup');
    await stopping;
    expect(dependencies.health.ready).not.toHaveBeenCalled();
    expect(dependencies.boss.stop).toHaveBeenCalledOnce();
    expect(dependencies.database.end).toHaveBeenCalledOnce();
    expect(dependencies.health.close).toHaveBeenCalledOnce();
  });

  // what_bug_this_catches: initial recovery blocks shutdown indefinitely after every consumer is ready.
  it('does not make shutdown wait for a pending initial recovery', async () => {
    const gate = deferred();
    const { lifecycle, dependencies } = fixture();
    dependencies.recover = vi.fn(() => gate.promise);
    await lifecycle.start();
    expect(dependencies.health.ready).toHaveBeenCalledOnce();
    await lifecycle.shutdown();
    expect(dependencies.boss.stop).toHaveBeenCalledOnce();
    expect(dependencies.database.end).toHaveBeenCalledOnce();
    expect(dependencies.health.close).toHaveBeenCalledOnce();
    gate.resolve();
  });

  // what_bug_this_catches: repeated signals close only one resource or throw during duplicate cleanup.
  it('stops pg-boss, the database, and health exactly once', async () => {
    const { lifecycle, dependencies, events } = fixture();
    await lifecycle.start();
    await Promise.all([lifecycle.shutdown(), lifecycle.shutdown()]);
    expect(dependencies.boss.stop).toHaveBeenCalledTimes(1);
    expect(dependencies.database.end).toHaveBeenCalledTimes(1);
    expect(dependencies.health.close).toHaveBeenCalledTimes(1);
    expect(events.slice(-4)).toEqual(['health:stopping', 'boss:stop', 'database:end', 'health:close']);
  });

  // what_bug_this_catches: the HTTP endpoint returns 200 merely because its listener is bound.
  it('serves 503 until explicitly ready and stops accepting requests after close', async () => {
    const health = createWorkerHealth(0);
    await health.listen();
    const port = health.port();
    expect(port).not.toBeNull();
    const url = `http://127.0.0.1:${String(port)}/healthz`;
    expect((await fetch(url)).status).toBe(503);
    health.ready();
    const ready = await fetch(url);
    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toMatchObject({ status: 'ok', service: 'worker' });
    health.stopping();
    expect((await fetch(url)).status).toBe(503);
    await health.close();
    await expect(fetch(url)).rejects.toThrow();
  });
});
