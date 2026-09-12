import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { createNotify, createSimulator, defaultPreferences, type Attempt, type AuditIntent, type Identity, type Job,
  type NotifyPreferences, type PendingAudit, type Repository, type Transaction, type JobQueue } from '../../../packages/notify/src/index.ts';
import type { InboxPublisher } from '../../../packages/notify/src/types.ts';

export const orgId = '11111111-1111-4111-8111-111111111111';
export const otherOrg = '22222222-2222-4222-8222-222222222222';
export const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const otherUser = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const identity = { orgId, userId };
export const request = { recipientId: userId, purpose: 'task_notice', channel: 'sms', idempotencyKey: 'event-1', template: 'task.update', params: { detail: 'private resident content' } } as const;
export const optedIn = (): NotifyPreferences => ({ ...defaultPreferences(), no_outbound: false,
  channels: { task_notice: { email: true, sms: true, voice: true } } });

/** Transactional test double. PostgreSQL tests independently prove locking/RLS. */
export class MemoryRepository implements Repository {
  preferences = new Map<string, NotifyPreferences>();
  jobs = new Map<string, Job>();
  attempts: Attempt[] = [];
  audits: (PendingAudit & { owner: string })[] = [];
  committed = false;
  private committedAudits = new Set<string>();
  private committedIntents = new WeakSet<AuditIntent>();
  isCommitted(intent: AuditIntent) { return this.committedIntents.has(intent); }
  private tail = Promise.resolve();
  private key(scope: Identity) { return `${scope.orgId}:${scope.userId}`; }
  async transaction<T>(scope: Identity, work: (tx: Transaction) => Promise<T>): Promise<T> {
    const prior = this.tail;
    let release = () => {};
    this.tail = new Promise(resolve => { release = resolve; });
    await prior;
    const backup = structuredClone({ preferences: this.preferences, jobs: this.jobs, attempts: this.attempts, audits: this.audits });
    this.committed = false;
    const key = this.key(scope);
    const scoped = (job: Job) => job.orgId === scope.orgId && job.userId === scope.userId;
    try {
      const result = await work({
        preferences: () => Promise.resolve(structuredClone(this.preferences.get(key) ?? defaultPreferences())),
        savePreferences: value => { this.preferences.set(key, structuredClone(value)); return Promise.resolve(); },
        insert: value => {
          const prior = [...this.jobs.values()].find(job => scoped(job) && job.channel === value.channel && job.payload.idempotency_key === value.payload.idempotency_key);
          if (!prior) this.jobs.set(value.id, structuredClone(value));
          return Promise.resolve(structuredClone(prior ?? value));
        },
        job: id => { const job = this.jobs.get(id); return Promise.resolve(job && scoped(job) ? structuredClone(job) : null); },
        save: value => { if (scoped(value)) this.jobs.set(value.id, structuredClone(value)); return Promise.resolve(); },
        attempt: value => { this.attempts.push(structuredClone(value)); return Promise.resolve(); },
        audit: intent => { this.audits.push({ id: randomUUID(), intent, owner: key }); return Promise.resolve(); },
      });
      this.committed = true;
      for (const audit of this.audits) { this.committedAudits.add(audit.id); this.committedIntents.add(audit.intent); }
      return result;
    } catch (error) { Object.assign(this, backup); throw error; }
    finally { release(); }
  }
  pendingAudits(scope: Identity) { return Promise.resolve(this.audits.filter(a => a.owner === this.key(scope) && this.committedAudits.has(a.id))); }
  acknowledgeAudit(scope: Identity, id: string) {
    this.audits = this.audits.filter(a => a.id !== id || a.owner !== this.key(scope)); return Promise.resolve();
  }
  schedulable(scope: Identity) {
    return Promise.resolve([...this.jobs.values()].filter(j => j.orgId === scope.orgId && j.userId === scope.userId &&
      (['pending', 'send_failed'].includes(j.state) || (j.state === 'delivered' && j.payload.purpose === 'event_reminder'))));
  }
}

export function fixture() {
  const repository = new MemoryRepository();
  const intents: AuditIntent[] = [];
  let now = new Date('2026-09-10T16:00:00Z');
  const deps = {
    repository,
    audit: { emit: vi.fn((intent: AuditIntent) => { if (!repository.isCommitted(intent)) throw new Error('Audit before commit'); intents.push(intent); return Promise.resolve(); }) },
    flags: { enabled: vi.fn(() => Promise.resolve(false)) },
    authorization: { canNotify: vi.fn((actor: Identity, recipient: string, _purpose?: string, _resourceId?: string) => Promise.resolve(actor.orgId === orgId && actor.userId === recipient)),
      canDisclose: vi.fn(() => Promise.resolve(false)) },
    queue: { enqueue: vi.fn<JobQueue['enqueue']>(() => Promise.resolve()) },
    inbox: { publish: vi.fn<InboxPublisher['publish']>(() => Promise.resolve()) },
    adapter: { send: vi.fn((delivery: Parameters<ReturnType<typeof createSimulator>['send']>[0]) => createSimulator().send(delivery)) },
    renderer: { body: vi.fn(() => Promise.resolve('private resident content')), destination: vi.fn(() => Promise.resolve('synthetic@example.invalid')) },
    clock: () => new Date(now),
  };
  return { deps, repository, intents, service: createNotify(deps), setNow: (date: string) => { now = new Date(date); } };
}
