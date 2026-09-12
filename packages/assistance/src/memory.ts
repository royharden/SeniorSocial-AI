import { ConflictError } from './types.ts';
import type { AssistanceRepository, AssistanceRequest, AssistanceTransaction, AuditIntent, NewRequest } from './types.ts';

function clone(request: AssistanceRequest): AssistanceRequest { return { ...request }; }
export class MemoryAssistanceRepository implements AssistanceRepository {
  readonly requests = new Map<string, AssistanceRequest>();
  readonly audits: AuditIntent[] = [];
  readonly idempotency = new Map<string, string>();

  async transaction<T>(orgId: string, work: (transaction: AssistanceTransaction) => Promise<T>): Promise<T> {
    const requests = new Map([...this.requests].map(([id, request]) => [id, clone(request)]));
    const audits = [...this.audits];
    const idempotency = new Map(this.idempotency);
    const scoped = () => [...requests.values()].filter(request => request.orgId === orgId);
    const transaction: AssistanceTransaction = {
      insert: (request: NewRequest, key: string) => {
        const existingId = idempotency.get(`${orgId}:${request.requesterId}:${key}`);
        const existing = existingId ? requests.get(existingId) : undefined;
        if (existing) return Promise.resolve({ request: clone(existing), created: false });
        const value = { ...request, summary: request.summary };
        requests.set(value.id, value);
        idempotency.set(`${orgId}:${request.requesterId}:${key}`, value.id);
        return Promise.resolve({ request: clone(value), created: true });
      },
      find: id => { const value = requests.get(id); return Promise.resolve(value?.orgId === orgId ? clone(value) : null); },
      listForRequester: requesterId => Promise.resolve(scoped().filter(item => item.requesterId === requesterId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).map(clone)),
      listQueue: () => Promise.resolve(scoped().filter(item => !['resolved', 'closed_unable'].includes(item.state)).sort((a, b) => a.slaDueAt.getTime() - b.slaDueAt.getTime() || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id)).map(clone)),
      transition: (id, expected, to, ownerId) => {
        const current = requests.get(id);
        if (!current || current.orgId !== orgId || current.state !== expected) throw new ConflictError('stale_transition');
        const next = { ...current, state: to, ownerId };
        requests.set(id, next); return Promise.resolve(clone(next));
      },
      markBreached: (id, at) => {
        const current = requests.get(id);
        if (!current || current.orgId !== orgId) throw new ConflictError('stale_sla_tick');
        if (current.slaBreachedAt) return Promise.resolve({ request: clone(current), created: false });
        const next = { ...current, slaBreachedAt: at }; requests.set(id, next);
        return Promise.resolve({ request: clone(next), created: true });
      },
      audit: intent => { if (intent.org_id !== orgId) throw new Error('audit tenant mismatch'); audits.push(intent); return Promise.resolve(); },
    };
    const result = await work(transaction);
    this.requests.clear(); for (const [id, request] of requests) this.requests.set(id, request);
    this.audits.splice(0, this.audits.length, ...audits);
    this.idempotency.clear(); for (const [key, id] of idempotency) this.idempotency.set(key, id);
    return result;
  }
}
