import {
  PostgresQualifiedReviewerRegistry,
  PostgresTranslationRepository,
  assertTranslationRuntimeRole,
  TranslationAiUnavailable,
  TranslationConflict,
  TranslationDenied,
  TranslationInvalid,
  TranslationWorkflow,
  createTranslationAuthorizer,
  type Actor,
  type TranslationGateway,
  type TranslationSql,
} from '@seniorsocial/i18n';
import { AuthService, PostgresAuthStore, assertConstrainedRuntimeRole, createAuthDatabaseClient, type AuthSql } from '@seniorsocial/auth';
import { AiEventRepository } from '@seniorsocial/audit';
import { createDatabaseClient } from '@seniorsocial/db';
import { FlagRepository } from '@seniorsocial/flags';
import { createWp006Gateway, DurableRateLimiter, DurableReservationStore, FilePromptRegistry, FileRouter,
  InMemoryExactCache, loadPriceBook, StubProviderAdapter, type AiGateway } from '@seniorsocial/ai';

export interface TranslationRouteRuntime {
  execute<T>(request: Request, action: (actor: Actor, workflow: TranslationWorkflow) => Promise<T>): Promise<T>;
}

export function createPostgresTranslationRuntime(dependencies: {
  resolveActor(request: Request): Promise<Actor | null>;
  withTenantSql<T>(orgId: string, work: (sql: TranslationSql) => Promise<T>): Promise<T>;
  gateway?: TranslationGateway;
}): TranslationRouteRuntime {
  return {
    async execute<T>(request: Request, action: (actor: Actor, workflow: TranslationWorkflow) => Promise<T>): Promise<T> {
      const actor = await dependencies.resolveActor(request);
      if (!actor?.orgId || !actor.userId) throw new TranslationDenied();
      return dependencies.withTenantSql(actor.orgId, async sql => {
        await assertTranslationRuntimeRole(sql);
        const authorizer = createTranslationAuthorizer(new PostgresQualifiedReviewerRegistry(sql));
        const workflow = new TranslationWorkflow(new PostgresTranslationRepository(sql), authorizer, dependencies.gateway);
        return action(actor, workflow);
      });
    },
  };
}

function cookie(request: Request, name: string): string | null {
  for (const value of request.headers.get('cookie')?.split(';') ?? []) {
    const [key, ...parts] = value.trim().split('=');
    if (key === name) {
      try { return decodeURIComponent(parts.join('=')); } catch { return null; }
    }
  }
  return null;
}

/** Production-ready composition: identity comes only from the WP-004 session. */
export function createDefaultTranslationRuntime(gateway?: TranslationGateway): TranslationRouteRuntime {
  return {
    async execute<T>(request: Request, action: (actor: Actor, workflow: TranslationWorkflow) => Promise<T>): Promise<T> {
      const orgId = process.env.SENIORSOCIAL_ORG_ID;
      const pepper = process.env.AUTH_TOKEN_PEPPER;
      const token = cookie(request, 'ss_session');
      if (!orgId || !pepper || !token) throw new TranslationDenied();
      const client = createAuthDatabaseClient();
      try {
        const result = await client.begin(async transaction => {
          await assertConstrainedRuntimeRole(transaction as unknown as AuthSql);
          await transaction`select set_config('app.current_org_id', ${orgId}, true)`;
          const session = await new AuthService(new PostgresAuthStore(transaction as unknown as AuthSql), { pepper }).session(orgId, token);
          if (!session) throw new TranslationDenied();
          const actor: Actor = { orgId: session.orgId, userId: session.userId, roles: session.roles };
          const sql = transaction as unknown as TranslationSql;
          await assertTranslationRuntimeRole(sql);
          const workflow = new TranslationWorkflow(new PostgresTranslationRepository(sql), createTranslationAuthorizer(new PostgresQualifiedReviewerRegistry(sql)), gateway);
          return action(actor, workflow);
        });
        return result as T;
      } finally {
        await client.end();
      }
    },
  };
}

let aiResources: { client: ReturnType<typeof createDatabaseClient>; gateway: Promise<AiGateway> } | undefined;
function configuredTranslationGateway(): TranslationGateway | undefined {
  if ((process.env.AI_PROVIDER ?? 'stub') !== 'stub') return undefined;
  return { translate: input => translationAiGateway().then(gateway => gateway.translate(input)) };
}

function translationAiGateway(): Promise<AiGateway> {
  if (aiResources) return aiResources.gateway;
  const client = createDatabaseClient();
  const flags = new FlagRepository(client);
  const gateway = (async () => {
    const router = await new FileRouter(undefined, 'stub').load();
    const stub = new StubProviderAdapter();
    return createWp006Gateway(flags, new AiEventRepository(client), {
      prompts: new FilePromptRegistry(), router, providers: new Map([['stub', stub]]),
      rateLimiter: new DurableRateLimiter(client, 20, 200), reservations: new DurableReservationStore(client),
      cache: new InMemoryExactCache(),
      cacheBoundary: { describe: () => Promise.resolve({ cacheable: false, sourceContentVersionSet: [] }), reauthorize: () => Promise.resolve(false) },
      prices: await loadPriceBook(),
    });
  })();
  aiResources = { client, gateway };
  return gateway;
}

export const defaultTranslationRuntime = createDefaultTranslationRuntime(configuredTranslationGateway());

export async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TranslationInvalid('JSON object required');
    return body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof TranslationInvalid) throw error;
    throw new TranslationInvalid('JSON object required');
  }
}

export function exactBody(body: Record<string, unknown>, allowed: readonly string[]): void {
  const forbidden = ['orgId', 'org_id', 'actor', 'actorId', 'actor_id', 'reviewer', 'reviewedBy', 'reviewed_by', 'qualification'];
  if (Object.keys(body).some(key => forbidden.includes(key) || !allowed.includes(key))) throw new TranslationInvalid('Unexpected field');
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const hashPattern = /^[0-9a-f]{64}$/u;
export function uuid(value: unknown): string { if (typeof value !== 'string' || !uuidPattern.test(value)) throw new TranslationInvalid('Invalid identifier'); return value; }
export function hash(value: unknown): string { if (typeof value !== 'string' || !hashPattern.test(value)) throw new TranslationInvalid('Invalid source hash'); return value; }
export function positiveVersion(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new TranslationInvalid('Invalid source version'); return value as number; }
export function bounded(value: unknown, name: string, max: number): string { if (typeof value !== 'string' || !value.trim() || value.length > max) throw new TranslationInvalid(`Invalid ${name}`); return value.trim(); }
export function canonicalSourceVersion(value: unknown): { version: number; hash: string } {
  if (typeof value !== 'string') throw new TranslationInvalid('Invalid source version');
  const match = /^(\d+):([0-9a-f]{64})$/u.exec(value); if (!match) throw new TranslationInvalid('Invalid source version');
  const version = Number(match[1]); if (!Number.isSafeInteger(version) || version <= 0 || !match[2]) throw new TranslationInvalid('Invalid source version');
  return { version, hash: match[2] };
}

export function translationProblem(error: unknown): Response {
  if (error instanceof TranslationDenied) return problem(404, 'not_found', 'Translation not found');
  if (error instanceof TranslationConflict) return problem(409, error.code, 'Translation changed; reload before continuing');
  if (error instanceof TranslationInvalid) return problem(422, error.code, 'Invalid translation request');
  if (error instanceof TranslationAiUnavailable) return problem(503, error.code, 'Machine drafting is unavailable; use the manual draft path');
  const sqlState = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : null;
  if (sqlState === '42501') return problem(404, 'not_found', 'Translation not found');
  if (sqlState === '22P02') return problem(422, 'invalid_request', 'Invalid translation request');
  if (sqlState?.startsWith('23')) return problem(409, 'translation_conflict', 'Translation changed; reload before continuing');
  return problem(500, 'translation_error', 'Translation operation failed');
}

function problem(status: number, code: string, title: string): Response {
  return Response.json({ type: `urn:seniorsocial:problem:${code}`, code, title, status }, { status, headers: { 'cache-control': 'no-store', 'content-type': 'application/problem+json' } });
}

export const unavailableTranslationRuntime: TranslationRouteRuntime = {
  execute: () => Promise.reject(new TranslationDenied()),
};
