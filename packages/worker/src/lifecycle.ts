import type { WorkerHealth } from './health.ts';

export interface WorkerBoss {
  start(): Promise<unknown>;
  stop(): Promise<unknown>;
}

export interface WorkerDatabase {
  end(): Promise<unknown>;
}

export interface WorkerLifecycleDependencies {
  health: WorkerHealth;
  boss: WorkerBoss;
  database: WorkerDatabase;
  registerNotificationConsumers(): Promise<void>;
  registerPrintConsumer(): Promise<void>;
  recover(): Promise<void>;
  recoveryIntervalMs?: number;
}

export class WorkerLifecycle {
  private state: 'new' | 'starting' | 'ready' | 'stopping' | 'stopped' = 'new';
  private stopRequested = false;
  private queueFailure = false;
  private bossStarted = false;
  private recoveryTimer: NodeJS.Timeout | undefined;
  private recoveryRunning = false;
  private startPromise: Promise<void> | undefined;
  private cleanupPromise: Promise<void> | undefined;
  private shutdownPromise: Promise<void> | undefined;

  constructor(private readonly dependencies: WorkerLifecycleDependencies) {}

  async start(): Promise<void> {
    if (this.state !== 'new') throw new Error('Worker lifecycle already started');
    this.state = 'starting';
    this.startPromise = this.doStart();
    try {
      await this.startPromise;
    } catch (error) {
      if (!this.stopRequested && !this.queueFailure) this.dependencies.health.failed();
      await this.cleanup();
      throw error;
    }
  }

  queueFailed(): void {
    this.queueFailure = true;
    this.dependencies.health.failed();
  }

  shutdown(): Promise<void> {
    this.stopRequested = true;
    if (this.state !== 'stopped') {
      this.state = 'stopping';
      this.dependencies.health.stopping();
    }
    this.shutdownPromise ??= (async () => {
      try { await this.startPromise; } catch { /* Startup owns its diagnostic. */ }
      await this.cleanup();
    })();
    return this.shutdownPromise;
  }

  private async doStart(): Promise<void> {
    await this.dependencies.health.listen();
    this.assertStarting();
    await this.dependencies.boss.start();
    this.bossStarted = true;
    this.assertStarting();
    await this.dependencies.registerNotificationConsumers();
    this.assertStarting();
    await this.dependencies.registerPrintConsumer();
    this.assertStarting();
    this.state = 'ready';
    this.dependencies.health.ready();
    void this.runRecovery();
    this.assertStartingOrReady();
    const interval = this.dependencies.recoveryIntervalMs ?? 60_000;
    this.recoveryTimer = setInterval(() => { void this.runRecovery(); }, interval);
  }

  private assertStarting(): void {
    if (this.queueFailure) throw new Error('Worker queue failed during startup');
    if (this.stopRequested || this.state !== 'starting') throw new Error('Worker stopped during startup');
  }

  private assertStartingOrReady(): void {
    if (this.queueFailure) throw new Error('Worker queue failed during startup');
    if (this.stopRequested || this.state !== 'ready') throw new Error('Worker stopped during startup');
  }

  private async runRecovery(): Promise<void> {
    if (this.recoveryRunning || this.state !== 'ready') return;
    this.recoveryRunning = true;
    try {
      await this.dependencies.recover();
    } catch {
      if (this.state === 'ready') process.stderr.write('Notification recovery remains pending\n');
    } finally {
      this.recoveryRunning = false;
    }
  }

  private cleanup(): Promise<void> {
    this.cleanupPromise ??= this.doCleanup();
    return this.cleanupPromise;
  }

  private async doCleanup(): Promise<void> {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    const failures: unknown[] = [];
    if (this.bossStarted) {
      try { await this.dependencies.boss.stop(); } catch (error) { failures.push(error); }
    }
    try { await this.dependencies.database.end(); } catch (error) { failures.push(error); }
    try { await this.dependencies.health.close(); } catch (error) { failures.push(error); }
    this.state = 'stopped';
    if (failures.length > 0) throw new AggregateError(failures, 'Worker shutdown failed');
  }
}
