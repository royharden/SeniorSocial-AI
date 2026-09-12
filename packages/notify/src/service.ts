import { createHash, randomUUID } from 'node:crypto';
import { catalogSourceSha256, catalogs, resolveCatalogMessage, type CatalogRenderState, type ResolutionReviewStatus } from '../../i18n/src/catalogs.ts';
import { channels, nextDeliveryAt, permits, purposes, replacePreferences, type Channel, type Purpose } from './preferences.ts';
import type { Adapter, AuditIntent, AuditSink, Authorization, FeatureGate, Identity, InboxPublisher, Job, JobQueue, Renderer, Repository } from './types.ts';
import { eventReminderNotice } from './resident.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function identityValid(identity: Identity): boolean { return uuid.test(identity.orgId) && uuid.test(identity.userId); }
const denied = () => ({ status: 'suppressed' } as const);

export interface MinimalNotificationArtifact {
  readonly body: string;
  readonly catalogKey: 'body.minimal';
  readonly requestedLocale: 'en' | 'es';
  readonly renderedLocale: 'en' | 'es';
  readonly renderState: CatalogRenderState;
  readonly reviewStatus: ResolutionReviewStatus;
  readonly sourceVersion: `sha256:${string}`;
}

/** Content-free notification copy with the catalog decision preserved as provenance. */
export function minimalNotificationArtifact(locale: 'en' | 'es'): MinimalNotificationArtifact {
  const resolution = resolveCatalogMessage({ locale, namespace: 'notify', key: 'body.minimal' });
  if (!resolution.found || resolution.renderedLocale === null) throw new Error('Notification catalog unavailable');
  return Object.freeze({
    body: resolution.affordance === null ? resolution.text : `${resolution.text}\n\n${resolution.affordance}`,
    catalogKey: 'body.minimal',
    requestedLocale: locale,
    renderedLocale: resolution.renderedLocale,
    renderState: resolution.renderState,
    reviewStatus: resolution.reviewStatus,
    sourceVersion: `sha256:${catalogSourceSha256(catalogs.en.notify)}`,
  });
}

export interface EnqueueRequest {
  recipientId: string;
  channel: Channel;
  purpose: Purpose;
  idempotencyKey: string;
  template: string;
  params: Record<string, string>;
  /** Required for message notices so authorization can be rechecked at delivery. */
  resourceId?: string;
}
export interface Dependencies {
  repository: Repository;
  audit: AuditSink;
  authorization: Authorization;
  flags: FeatureGate;
  queue: JobQueue;
  adapter: Adapter;
  renderer: Renderer;
  inbox?: InboxPublisher;
  clock: () => Date;
}

export function createNotify(deps: Dependencies) {
  const { repository, audit, authorization, flags, queue, adapter, renderer, inbox, clock } = deps;
  const intent = (identity: Identity, action: AuditIntent['action'], outcome: AuditIntent['outcome'], reason: string, id?: string): AuditIntent => ({
    actor: `user:${identity.userId}`, on_behalf_of: null, action,
    target: id ? `notification:${id}` : 'notification:restricted', org_id: identity.orgId, outcome, reason,
  });
  async function flushAudit(identity: Identity): Promise<void> {
    // At-least-once delivery. A sink failure remains durable for retry; never swallow it.
    for (const pending of await repository.pendingAudits(identity)) {
      await audit.emit(pending.intent, pending.id);
      await repository.acknowledgeAudit(identity, pending.id);
    }
  }
  async function allowed(identity: Identity, recipientId: string, purpose: Purpose, resourceId?: string): Promise<boolean> {
    if (!identityValid(identity) || !uuid.test(recipientId)) return false;
    if (purpose === 'message' && (!resourceId || !uuid.test(resourceId))) return false;
    if (resourceId && !uuid.test(resourceId)) return false;
    try { return await authorization.canNotify(identity, recipientId, purpose, resourceId) === true; } catch { return false; }
  }
  async function voiceAllowed(channel: Channel, orgId: string): Promise<boolean> {
    if (channel !== 'voice') return true;
    // Canonical off => simulator. On requests a real provider, unavailable in this
    // local-only slice: fail closed. The flag is consulted at enqueue AND send.
    try { return await flags.enabled('notify.voice.real_send', orgId) === false; } catch { return false; }
  }
  const authorizationResource = (job: Job): string | undefined => job.payload.resource_id ??
    (job.payload.purpose === 'event_reminder' ? job.payload.params.event_id : undefined);
  async function transferDelivered(job: Job): Promise<void> {
    if (!inbox || job.payload.purpose !== 'event_reminder') return;
    const eventId = authorizationResource(job);
    const sender = { orgId: job.orgId, userId: job.actorId };
    if (!eventId || !uuid.test(eventId) || !await allowed(sender, job.userId, job.payload.purpose, eventId)) return;
    const notice = eventReminderNotice(eventId, job.payload.locale);
    await inbox.publish({ orgId: job.orgId, userId: job.userId }, `event-reminder:${eventId}`, {
      purpose: 'event_reminder', ...notice,
    });
  }
  async function suppress(identity: Identity): Promise<ReturnType<typeof denied>> {
    if (identityValid(identity)) {
      await repository.transaction(identity, tx => tx.audit(intent(identity, 'notification.suppressed', 'denied', 'notification_policy_denied')));
      await flushAudit(identity);
    }
    return denied();
  }
  async function replace(identity: Identity, input: unknown) {
    if (!await allowed(identity, identity.userId, 'task_notice')) return suppress(identity);
    const preferences = await repository.transaction(identity, async tx => {
      const next = replacePreferences(await tx.preferences(), input);
      await tx.savePreferences(next);
      await tx.audit(intent(identity, 'notification.preferences_changed', 'allowed', 'preferences_saved'));
      return next;
    });
    await flushAudit(identity);
    return { status: 'saved', preferences } as const;
  }
  async function enqueue(identity: Identity, request: EnqueueRequest) {
    if (!channels.includes(request.channel) || !purposes.includes(request.purpose) ||
      !/^[a-zA-Z0-9:_-]{1,160}$/.test(request.idempotencyKey) || !/^[a-z][a-z0-9_.-]{0,79}$/.test(request.template) ||
      request.params === null || typeof request.params !== 'object' || Array.isArray(request.params) ||
      Object.keys(request.params).length > 20 || Object.entries(request.params).some(([key, value]) =>
        !/^[a-z][a-z0-9_]{0,39}$/.test(key) || typeof value !== 'string' || value.length > 1000)) throw new Error('Invalid notification');
    const resourceId = request.resourceId ?? (request.purpose === 'event_reminder' ? request.params.event_id : undefined);
    if (!await allowed(identity, request.recipientId, request.purpose, resourceId) || !await voiceAllowed(request.channel, identity.orgId)) return suppress(identity);
    const recipient = { orgId: identity.orgId, userId: request.recipientId };
    const result = await repository.transaction(recipient, async tx => {
      const preferences = await tx.preferences();
      if (!permits(preferences, request.purpose, request.channel)) {
        await tx.audit(intent(identity, 'notification.suppressed', 'denied', 'notification_policy_denied'));
        return null;
      }
      const id = randomUUID();
      const job = await tx.insert({ id, orgId: identity.orgId, userId: request.recipientId, actorId: identity.userId,
        channel: request.channel, state: 'pending', dueAt: nextDeliveryAt(clock(), preferences, request.purpose), attempts: 0, synthetic: true,
        payload: { org_id: identity.orgId, user_id: request.recipientId, purpose: request.purpose, template: request.template,
          locale: preferences.locale, params: structuredClone(request.params),
          ...(request.resourceId ? { resource_id: request.resourceId } : {}),
          idempotency_key: createHash('sha256').update(JSON.stringify([identity.orgId, request.recipientId, request.channel, request.idempotencyKey])).digest('hex') } });
      if (job.id === id) await tx.audit(intent(identity, 'notification.queued', 'allowed', 'notification_queued', job.id));
      return job;
    });
    await flushAudit(recipient);
    if (!result) return denied();
    if (result.state === 'pending' || result.state === 'send_failed') await queue.enqueue(`notify.send.${result.channel}`, result.payload, result.dueAt);
    return { status: result.state, id: result.id } as const;
  }
  async function send(identity: Identity, jobId: string) {
    // The queue consumer supplies trusted tenant + recipient context, not an arbitrary global id.
    if (!identityValid(identity) || !uuid.test(jobId)) return denied();
    const prepared = await repository.transaction(identity, async tx => {
      const job = await tx.job(jobId);
      if (!job) return null;
      if (job.state !== 'pending' && job.state !== 'send_failed') return { job, ready: false };
      const sender = { orgId: job.orgId, userId: job.actorId };
      const preferences = await tx.preferences();
      if (!await allowed(sender, job.userId, job.payload.purpose, authorizationResource(job)) || !permits(preferences, job.payload.purpose, job.channel) || !await voiceAllowed(job.channel, job.orgId)) {
        job.state = 'suppressed';
        await tx.save(job);
        await tx.audit(intent(sender, 'notification.suppressed', 'denied', 'notification_policy_denied', job.id));
        return { job, ready: false };
      }
      const now = clock();
      job.dueAt = nextDeliveryAt(new Date(Math.max(now.getTime(), job.dueAt.getTime())), preferences, job.payload.purpose);
      if (job.dueAt > now) { await tx.save(job); return { job, ready: false }; }
      job.state = 'sending';
      job.attempts++;
      await tx.save(job);
      await tx.attempt({ id: randomUUID(), jobId, sequence: job.attempts, outcome: 'started', synthetic: true });
      await tx.audit(intent(sender, 'notification.attempted', 'allowed', 'synthetic_delivery_started', job.id));
      return { job, ready: true };
    });
    let auditError: unknown;
    let auditFailed = false;
    try { await flushAudit(identity); } catch (error) { auditFailed = true; auditError = error; }
    if (!prepared) { if (auditFailed) throw auditError; return denied(); }
    if (!prepared.ready) {
      if (prepared.job.state === 'pending' || prepared.job.state === 'send_failed') await queue.enqueue(`notify.send.${prepared.job.channel}`, prepared.job.payload, prepared.job.dueAt);
      if (prepared.job.state === 'delivered') await transferDelivered(prepared.job);
      if (auditFailed) throw auditError;
      return { status: prepared.job.state, synthetic: true } as const;
    }
    const job = prepared.job;
    const sender = { orgId: job.orgId, userId: job.actorId };
    type Outcome = 'confirmed' | 'failed' | 'ambiguous' | 'suppressed';
    let outcome: Outcome = 'failed';
    let invoked = false;
    let retryAt = new Date(clock().getTime() + 60_000);
    try {
      const boundary = await repository.transaction(identity, async tx => {
        const current = await tx.job(jobId);
        if (!current || current.state !== 'sending' || current.attempts !== job.attempts) return { result: 'suppressed' as const };
        const preferences = await tx.preferences();
        const authorized = async () => await allowed(sender, job.userId, job.payload.purpose, authorizationResource(job)) && await voiceAllowed(job.channel, job.orgId);
        if (!permits(preferences, job.payload.purpose, job.channel) || !await authorized()) return { result: 'suppressed' as const };
        const dueAt = nextDeliveryAt(clock(), preferences, job.payload.purpose);
        if (dueAt > clock()) { retryAt = dueAt; return { result: 'failed' as const }; }
        // The recipient lock serializes preference changes with destination/body
        // rendering and the start of adapter invocation, not its network response.
        const destination = await renderer.destination(job);
        if (!await authorized()) return { result: 'suppressed' as const };
        const body = preferences.shared_device && job.channel !== 'email'
          ? minimalNotificationArtifact(job.payload.locale).body
          : await renderer.body(job);
        if (!await authorized()) return { result: 'suppressed' as const };
        invoked = true;
        // Attach rejection handling immediately; only an invoked adapter can be
        // ambiguous. Return the promise inside an object to release the DB lock
        // before waiting for the network response. The claim is already durable.
        const response = adapter.send({ jobId: job.id, channel: job.channel, idempotencyKey: job.payload.idempotency_key, destination, body })
          .then((receipt): Outcome => receipt.synthetic === true && ['confirmed', 'failed', 'ambiguous'].includes(receipt.outcome) ? receipt.outcome : 'ambiguous',
            (): Outcome => 'ambiguous');
        return { response };
      });
      outcome = 'response' in boundary ? await boundary.response : boundary.result;
    } catch { outcome = invoked ? 'ambiguous' : 'failed'; }
    await repository.transaction(identity, async tx => {
      const current = await tx.job(jobId);
      if (!current || current.state !== 'sending' || current.attempts !== job.attempts) return;
      current.state = outcome === 'confirmed' ? 'delivered' : outcome === 'failed' ? 'send_failed' : outcome;
      current.dueAt = retryAt;
      await tx.save(current);
      await tx.attempt({ id: randomUUID(), jobId, sequence: current.attempts, outcome, synthetic: true });
      await tx.audit(intent(sender, outcome === 'suppressed' ? 'notification.suppressed' : 'notification.attempted',
        outcome === 'confirmed' ? 'allowed' : outcome === 'suppressed' ? 'denied' : 'error', `synthetic_delivery_${outcome}`, jobId));
    });
    // Audit availability must not gate known-unsent recovery or finalization.
    if (outcome === 'failed') await queue.enqueue(`notify.send.${job.channel}`, job.payload, retryAt);
    if (outcome === 'confirmed') await transferDelivered(job);
    if (auditFailed) throw auditError;
    await flushAudit(identity);
    return { status: outcome === 'confirmed' ? 'delivered' : outcome === 'failed' ? 'send_failed' : outcome, synthetic: true } as const;
  }
  async function recover(identity: Identity): Promise<void> {
    if (!identityValid(identity)) throw new Error('Invalid notification scope');
    for (const job of await repository.schedulable(identity)) {
      if (job.state === 'delivered') await transferDelivered(job);
      else await queue.enqueue(`notify.send.${job.channel}`, job.payload, job.dueAt);
    }
    await flushAudit(identity);
  }
  async function disclose<T>(identity: Identity, recipientId: string, resourceId: string, render: () => Promise<T>) {
    let permitted = false;
    if (identityValid(identity) && uuid.test(recipientId) && uuid.test(resourceId)) {
      try { permitted = await authorization.canDisclose(identity, recipientId, resourceId) === true; } catch { /* deny */ }
    }
    if (!permitted) return suppress(identity);
    return { status: 'allowed', value: await render() } as const;
  }
  // Scheduler recovery: re-enqueue by submitting the same key, or dispatch an
  // existing due row via send(). Never replay a persisted sending/ambiguous row.
  return { replace, enqueue, send, disclose, flushAudit, recover };
}

export type Notify = ReturnType<typeof createNotify>;
