import { ConflictError, ForbiddenError, NotFoundError } from './types.ts';
import { assistanceOpenedEvent, assistanceSlaTickJob } from './types.ts';
import { slaDueAt, triageByRules } from './triage.ts';
import type {
  AiTriagePort, AssistanceJobPort, AssistanceRepository, AssistanceRequest, AssistanceState, AuthorizationPort,
  BusinessHours, CreateInput, Identity, IdSource, NarrativeCodec, NotificationPort, TransitionInput,
  TriageCategory,
} from './types.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const operator = (identity: Identity) => identity.roles.includes('staff') || identity.roles.includes('admin');
const transitions: Readonly<Record<AssistanceState, readonly AssistanceState[]>> = {
  pending_unowned: ['owned'], owned: ['in_progress', 'closed_unable'],
  in_progress: ['resolved', 'closed_unable'], resolved: [], closed_unable: [],
};

export interface AssistanceServiceDependencies {
  repository: AssistanceRepository;
  authorization: AuthorizationPort;
  codec: NarrativeCodec;
  ids: IdSource;
  hours: BusinessHours;
  now?: () => Date;
  ai?: AiTriagePort;
  aiTimeoutMs?: number;
  notifications?: NotificationPort;
  jobs?: AssistanceJobPort;
}

export class AssistanceService {
  readonly #now: () => Date;
  constructor(private readonly dependencies: AssistanceServiceDependencies) {
    this.#now = dependencies.now ?? (() => new Date());
  }

  async create(identity: Identity, input: CreateInput): Promise<AssistanceRequest> {
    const summary = input.summary.trim();
    if (summary.length < 1 || summary.length > 2_000) throw new TypeError('summary must contain 1 to 2000 characters');
    if (input.idempotencyKey.length < 8 || input.idempotencyKey.length > 200) throw new TypeError('invalid idempotency key');
    if (!await this.dependencies.authorization.authorize(identity, { residentId: identity.userId, resourceId: identity.userId, operation: 'create' })) throw new ForbiddenError();
    const createdAt = this.#now();
    const ruleCategory = triageByRules(summary);
    const locale = input.locale ?? 'en';
    const triageCategory: TriageCategory = ruleCategory;
    let triageSource: 'rules' | 'ai' = 'rules';
    if (this.dependencies.ai) {
      try {
        // Never pass the resident narrative to a model. Native rules are sufficient.
        const timeoutMs = this.dependencies.aiTimeoutMs ?? 250;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<{ outcome: 'timeout' }>(resolve => { timer = setTimeout(() => resolve({ outcome: 'timeout' }), timeoutMs); });
        const result = await Promise.race([this.dependencies.ai.propose({ ruleCategory, locale }), timeout]);
        if (timer) clearTimeout(timer);
        // AI may corroborate native triage, never lower or replace it.
        if ('category' in result && result.category === ruleCategory) triageSource = 'ai';
      } catch { /* refusal, timeout, kill and adapter failure all preserve native triage */ }
    }
    const id = this.dependencies.ids.next();
    if (!uuid.test(id)) throw new Error('id source must return a UUID');
    const summaryCiphertext = await this.dependencies.codec.seal(summary);
    const stored = await this.dependencies.repository.transaction(identity.orgId, async transaction => {
      const inserted = await transaction.insert({
        id, orgId: identity.orgId, requesterId: identity.userId, summaryCiphertext, summary,
        locale, triageCategory, triageSource, state: 'pending_unowned', ownerId: null,
        afterHours: this.dependencies.hours.isAfterHours(createdAt),
        slaDueAt: slaDueAt(createdAt, triageCategory), slaBreachedAt: null, createdAt,
      }, input.idempotencyKey);
      if (inserted.created) await transaction.audit({ actor: `user:${identity.userId}`, action: 'assistance.opened',
        target: `assistance_request:${inserted.request.id}`, org_id: identity.orgId, outcome: 'allowed',
        reason: 'native assistance request saved', fields: ['after_hours', 'sla_due_at', 'state', 'triage_category', 'triage_source'] });
      return inserted;
    });
    const request = stored.request;
    if (stored.created) {
      // Transport failures occur after commit and cannot lose or advance the request.
      // Both ports receive stable keys so their durable adapters can retry safely.
      const work: Promise<void>[] = [];
      if (this.dependencies.notifications) work.push(Promise.resolve().then(() => this.dependencies.notifications?.queue({
        idempotencyKey: `assistance:${request.id}:opened`, audience: 'staff', event: assistanceOpenedEvent,
        payload: { request_id: request.id, org_id: request.orgId, requester_id: request.requesterId,
          triage_category: request.triageCategory, triage_source: request.triageSource, after_hours: request.afterHours },
      })).then(() => undefined));
      if (this.dependencies.jobs) work.push(Promise.resolve().then(() => this.dependencies.jobs?.enqueue(assistanceSlaTickJob,
        { idempotency_key: `assistance:${request.id}:sla`, org_id: request.orgId, request_id: request.id },
        request.slaDueAt)).then(() => undefined));
      await Promise.allSettled(work);
    }
    return request;
  }

  async listMine(identity: Identity): Promise<AssistanceRequest[]> {
    return this.dependencies.repository.transaction(identity.orgId, transaction => transaction.listForRequester(identity.userId));
  }

  async get(identity: Identity, id: string): Promise<AssistanceRequest> {
    return this.dependencies.repository.transaction(identity.orgId, async transaction => {
      const request = await transaction.find(id);
      if (!request) throw new NotFoundError();
      if (!await this.dependencies.authorization.authorize(identity, { residentId: request.requesterId, resourceId: request.id, operation: 'read' })) throw new NotFoundError();
      return request;
    });
  }

  async queue(identity: Identity): Promise<AssistanceRequest[]> {
    if (!operator(identity)) throw new ForbiddenError();
    return this.dependencies.repository.transaction(identity.orgId, transaction => transaction.listQueue());
  }

  async transition(identity: Identity, id: string, input: TransitionInput): Promise<AssistanceRequest> {
    if (!operator(identity)) throw new ForbiddenError();
    return this.dependencies.repository.transaction(identity.orgId, async transaction => {
      const current = await transaction.find(id);
      if (!current) throw new NotFoundError();
      if (!await this.dependencies.authorization.authorize(identity, { residentId: current.requesterId, resourceId: id, operation: 'manage' })) throw new NotFoundError();
      if (!transitions[current.state].includes(input.to)) throw new ConflictError();
      const assigning = current.state === 'pending_unowned' && input.to === 'owned';
      const ownerId = assigning ? input.ownerId ?? identity.userId : current.ownerId;
      if (!ownerId || !uuid.test(ownerId)) throw new ConflictError('owner_required');
      if (!assigning && input.ownerId && input.ownerId !== current.ownerId) throw new ConflictError('owner_is_immutable_during_transition');
      const reason = input.reason?.trim() || `${current.state}_to_${input.to}`;
      const updated = await transaction.transition(id, current.state, input.to, ownerId, identity.userId, reason);
      await transaction.audit({ actor: `user:${identity.userId}`, action: assigning ? 'assistance.owned' : 'assistance.transitioned',
        target: `assistance_request:${id}`, org_id: identity.orgId, outcome: 'allowed', reason,
        fields: assigning ? ['owner_id', 'state'] : ['state'] });
      return updated;
    });
  }

  async recordSlaBoundary(orgId: string, id: string): Promise<AssistanceRequest> {
    const now = this.#now();
    return this.dependencies.repository.transaction(orgId, async transaction => {
      const current = await transaction.find(id);
      if (!current) throw new NotFoundError();
      if (current.slaBreachedAt || current.state === 'resolved' || current.state === 'closed_unable') return current;
      if (now.getTime() < current.slaDueAt.getTime()) return current;
      const updated = await transaction.markBreached(id, now);
      if (updated.created) await transaction.audit({ actor: 'system:assistance-sla', action: 'assistance.sla_breached',
        target: `assistance_request:${id}`, org_id: orgId, outcome: 'allowed',
        reason: 'SLA due boundary reached', fields: ['sla_breached_at'] });
      return updated.request;
    });
  }
}
