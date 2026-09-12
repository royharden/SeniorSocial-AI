export type RagLocale = 'en' | 'es';

export interface RetrievalHit {
  readonly service_id: string;
  readonly score: number;
}

/** The response deliberately contains no generated or directory text. */
export interface RetrievalResponse { readonly items: readonly RetrievalHit[] }

export interface RetrievalRequest {
  readonly orgId: string;
  readonly userId: string;
  readonly userRole: 'senior' | 'caregiver' | 'staff' | 'admin' | 'partner' | 'support';
  readonly requestId: string;
  readonly locale: RagLocale;
  readonly query: string;
  readonly limit?: number;
  readonly onBehalfOf?: string;
}

export interface RagFlagReader {
  effective(flag: 'rag.enabled', orgId: string): Promise<boolean>;
}

/** Structural subset of WP-008 AiGateway. No provider adapter is accepted here. */
export interface AiGatewayEmbeddingPort {
  embed(request: {
    readonly feature: 'concierge';
    readonly context: {
      readonly orgId: string;
      readonly userId: string;
      readonly userRole: RetrievalRequest['userRole'];
      readonly locale: RagLocale;
      readonly requestId: string;
      readonly onBehalfOf?: string;
    };
    readonly inputs: readonly string[];
  }): Promise<{
    readonly outcome: 'ok' | 'refused' | 'error' | 'killed' | 'egress_blocked';
    readonly vectors: readonly (readonly number[])[];
    readonly dimensions: number;
    readonly model: string;
  }>;
}

export interface FtsSearchPort {
  search(orgId: string, input: { query: string; locale: RagLocale; limit: number }): Promise<{
    readonly items: readonly { readonly id: string }[];
  }>;
}

export interface RagSql {
  query<T>(text: string, values: readonly (string | number | null)[]): Promise<T[]>;
}
/** Privileged internal read used only to discover a globally unique published service's tenant. */
export interface RagTrustedStorage { query<T>(text: string, values: readonly string[]): Promise<T[]> }
export type RagOrgTransaction = <T>(orgId: string, work: (sql: RagSql) => Promise<T>) => Promise<T>;

export interface PreparedService {
  readonly serviceId: string;
  readonly content: string;
  readonly contentVersion: string;
  readonly contentFingerprint: string;
  readonly alreadyProcessed: boolean;
}

export interface RagRepository {
  prepare(orgId: string, serviceId: string, idempotencyKey: string): Promise<PreparedService | null>;
  replace(input: {
    orgId: string; serviceId: string; idempotencyKey: string; contentVersion: string;
    contentFingerprint: string; embedding: readonly number[]; dimensions: number; model: string;
  }): Promise<'indexed' | 'duplicate' | 'stale' | 'missing'>;
  hybrid(orgId: string, query: string, locale: RagLocale, embedding: readonly number[], dimensions: number,
    limit: number): Promise<readonly RetrievalHit[]>;
}

export interface ReindexJob {
  readonly idempotency_key: string;
  readonly service_id: string;
}

/** Resolves server-owned context; job payload fields are never trusted for tenancy or actor identity. */
export interface ReindexContextResolver {
  resolveService(serviceId: string): Promise<{
    readonly orgId: string;
    /** Trusted non-null published-service reviewer, used as WP-008's gateway user. */
    readonly gatewayUserId: string;
  } | null>;
}

export type ReindexResult =
  | { readonly outcome: 'disabled' | 'missing' | 'duplicate' | 'stale' }
  | { readonly outcome: 'indexed'; readonly service_id: string }
  | { readonly outcome: 'fallback'; readonly reason: 'embed_unavailable' | 'invalid_vector' };
