import { createHash } from 'node:crypto';
import type {
  AiGatewayEmbeddingPort, FtsSearchPort, RagFlagReader, RagRepository, ReindexContextResolver, ReindexJob, ReindexResult,
  RetrievalRequest, RetrievalResponse,
} from './types.ts';
import { boundedLimit, boundedQuery, ragLimits, safeScore, validIdempotencyKey, validUuid, validVector } from './validation.ts';

export interface RagServiceOptions {
  readonly flags: RagFlagReader;
  readonly gateway: AiGatewayEmbeddingPort;
  readonly fts: FtsSearchPort;
  readonly repository: RagRepository;
  readonly jobs: ReindexContextResolver;
}

export const ragReindexActor = 'system:rag-reindex' as const;

export function createRagService(options: RagServiceOptions) {
  const inFlightReindexes = new Map<string, Promise<ReindexResult>>();
  async function fallback(request: RetrievalRequest, query: string, limit: number): Promise<RetrievalResponse> {
    const response = await options.fts.search(request.orgId, { query, locale: request.locale, limit });
    return { items: response.items.slice(0, limit).map((item, index) => ({
      service_id: item.id, score: safeScore(1 / (index + 1)),
    })) };
  }

  async function embed(request: RetrievalRequest, input: string) {
    try {
      return await options.gateway.embed({
        feature: 'concierge',
        context: {
          orgId: request.orgId, userId: request.userId, userRole: request.userRole,
          locale: request.locale, requestId: request.requestId,
          ...(request.onBehalfOf ? { onBehalfOf: request.onBehalfOf } : {}),
        },
        inputs: [input],
      });
    } catch {
      return null;
    }
  }

  async function reindexOnce(job: ReindexJob): Promise<ReindexResult> {
    const context = await options.jobs.resolveService(job.service_id);
    if (!context) return { outcome: 'missing' };
    validUuid(context.orgId, 'resolved orgId'); validUuid(context.gatewayUserId, 'resolved gatewayUserId');
    if (!(await options.flags.effective('rag.enabled', context.orgId))) return { outcome: 'disabled' };
    const service = await options.repository.prepare(context.orgId, job.service_id, job.idempotency_key);
    if (!service) return { outcome: 'missing' };
    if (service.alreadyProcessed) return { outcome: 'duplicate' };
    const content = service.content.slice(0, ragLimits.contentCharacters);
    const requestId = `rag-reindex:${createHash('sha256').update(job.idempotency_key).digest('hex')}`;
    const request: RetrievalRequest = { orgId: context.orgId, userId: context.gatewayUserId, userRole: 'staff',
      requestId, locale: 'en', query: content };
    const result = await embed(request, content);
    const vector = result?.vectors[0]; const model = result?.model.trim() ?? '';
    if (!result || result.outcome !== 'ok') return { outcome: 'fallback', reason: 'embed_unavailable' };
    if (result.vectors.length !== 1 || !validVector(vector, result.dimensions) || !model || model.length > 200) {
      return { outcome: 'fallback', reason: 'invalid_vector' };
    }
    const outcome = await options.repository.replace({ orgId: context.orgId, serviceId: job.service_id,
      idempotencyKey: job.idempotency_key, contentVersion: service.contentVersion,
      contentFingerprint: service.contentFingerprint, embedding: vector, dimensions: result.dimensions, model });
    return outcome === 'indexed' ? { outcome, service_id: job.service_id } : { outcome };
  }

  return {
    async search(request: RetrievalRequest): Promise<RetrievalResponse> {
      validUuid(request.orgId, 'orgId'); validUuid(request.userId, 'userId'); validUuid(request.requestId, 'requestId');
      const query = boundedQuery(request.query); const limit = boundedLimit(request.limit);
      // This check precedes every possible gateway call: flag-off means exactly zero embedding calls.
      if (!query || !(await options.flags.effective('rag.enabled', request.orgId))) return fallback(request, query, limit);
      const result = await embed(request, query);
      const vector = result?.vectors[0];
      if (!result || result.outcome !== 'ok' || result.vectors.length !== 1 || !validVector(vector, result.dimensions)) {
        return fallback(request, query, limit);
      }
      try {
        const items = await options.repository.hybrid(request.orgId, query, request.locale, vector, result.dimensions, limit);
        return items.length ? { items } : fallback(request, query, limit);
      } catch {
        return fallback(request, query, limit);
      }
    },

    async reindex(job: ReindexJob): Promise<ReindexResult> {
      if (Object.keys(job).sort().join(',') !== 'idempotency_key,service_id') throw new Error('rag.reindex payload has unknown fields');
      validUuid(job.service_id, 'service_id'); validIdempotencyKey(job.idempotency_key);
      const key = `${job.service_id}\0${job.idempotency_key}`;
      const existing = inFlightReindexes.get(key);
      if (existing) return existing;
      const operation = reindexOnce(job);
      inFlightReindexes.set(key, operation);
      try { return await operation; }
      finally { if (inFlightReindexes.get(key) === operation) inFlightReindexes.delete(key); }
    },
  };
}

export type RagService = ReturnType<typeof createRagService>;
