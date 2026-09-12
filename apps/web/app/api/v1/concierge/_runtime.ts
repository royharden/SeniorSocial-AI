import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { AiEventRepository } from '../../../../../../packages/audit/src/index.ts';
import {
  type AssistanceRequest,
  type AssistanceService,
  type Identity,
  withPostgresAssistanceService,
} from '../../../../../../packages/assistance/src/index.ts';
import { loadConfig } from '../../../../../../packages/config/src/index.ts';
import { createDatabaseClient } from '../../../../../../packages/db/src/index.ts';
import { FlagRepository } from '../../../../../../packages/flags/src/index.ts';
import {
  createWp006Gateway,
  DurableRateLimiter,
  DurableReservationStore,
  FilePromptRegistry,
  FileRouter,
  InMemoryExactCache,
  loadPriceBook,
  StubProviderAdapter,
} from '../../../../../../packages/ai/src/index.ts';
import { ConciergeService, InMemoryConversationStore, type ConversationStore } from '../../../concierge/core.ts';
import { PostgresConversationStore } from '../../../concierge/postgres.ts';
import type {
  AssistanceCreationPort,
  AssistanceRequestRecord,
  ConciergeAiAvailabilityPort,
  ConciergeAiGatewayPort,
  ConciergeRole,
  ConciergeSession,
  DirectorySearchPort,
} from '../../../concierge/types.ts';
import { readCookie, SESSION_COOKIE, withAuthService } from '../../../(auth)/auth/_shared.ts';
import { servicesRepository } from '../services/_runtime.ts';
import type { ConciergeRouteDependencies } from './_shared.ts';

type Authorize = ConciergeRouteDependencies['authorize'];
interface RuntimeAdapters {
  authorize: Authorize;
  directory: DirectorySearchPort;
  ai: ConciergeAiGatewayPort;
  aiAvailability: ConciergeAiAvailabilityPort;
  assistance: AssistanceCreationPort;
}

const roleOrder: readonly ConciergeRole[] = ['senior', 'caregiver', 'staff', 'admin', 'partner', 'support'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const trustedAssistanceIdentity = new AsyncLocalStorage<Identity>();

const sessionAuthorize: Authorize = async request => {
  const orgId = process.env.SENIORSOCIAL_ORG_ID;
  if (!orgId || !uuid.test(orgId)) return null;
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  try {
    const authenticated = await withAuthService(orgId, service => service.session(orgId, token));
    if (!authenticated || authenticated.orgId !== orgId) return null;
    const role = roleOrder.find(candidate => authenticated.roles.includes(candidate));
    if (!role) return null;
    return { orgId, userId: authenticated.userId, role, locale: localeCookie(request), requestId: randomUUID() };
  } catch { return null; }
};

const directory: DirectorySearchPort = {
  search: async input => {
    const result = await servicesRepository().search(input.orgId, { query: input.query, locale: input.locale, limit: input.limit });
    return result.items.map(item => ({
      id: item.id, orgId: item.org_id, name: item.name, description: item.description,
      phone: item.phone, eligibilityNote: item.eligibility_note,
      languages: item.languages, accessibility: item.accessibility,
    }));
  },
};

const configuredProvider = process.env.AI_PROVIDER ?? 'stub';
export function hasConcreteConciergeProvider(provider: string): provider is 'stub' { return provider === 'stub'; }
const aiAvailability: ConciergeAiAvailabilityPort = {
  enabled: async orgId => hasConcreteConciergeProvider(configuredProvider)
    && await aiResources().flags.effective('ai.master', orgId)
    && await aiResources().flags.effective('ai.concierge', orgId),
};

let resources: { client: ReturnType<typeof createDatabaseClient>; flags: FlagRepository } | undefined;
function aiResources() {
  if (resources) return resources;
  const client = createDatabaseClient();
  resources = { client, flags: new FlagRepository(client) };
  return resources;
}

let gatewayPromise: Promise<ConciergeAiGatewayPort> | undefined;
function gateway(): Promise<ConciergeAiGatewayPort> {
  gatewayPromise ??= createGateway();
  return gatewayPromise;
}

async function createGateway(): Promise<ConciergeAiGatewayPort> {
  if (!hasConcreteConciergeProvider(configuredProvider)) throw new Error(`AI provider ${configuredProvider} has no registered runtime adapter`);
  const { client, flags } = aiResources();
  const router = await new FileRouter(undefined, 'stub').load();
  const stub = new StubProviderAdapter();
  return createWp006Gateway(flags, new AiEventRepository(client), {
    prompts: new FilePromptRegistry(), router, providers: new Map([['stub', stub]]),
    rateLimiter: new DurableRateLimiter(client, 20, 200), reservations: new DurableReservationStore(client),
    cache: new InMemoryExactCache(),
    cacheBoundary: { describe: () => Promise.resolve({ cacheable: false, sourceContentVersionSet: [] }), reauthorize: () => Promise.resolve(false) },
    prices: await loadPriceBook(),
  });
}

const ai: ConciergeAiGatewayPort = { chat: async input => (await gateway()).chat(input) };

type AssistanceServiceRunner = (
  configuration: { readonly encryptionKey: string; readonly timeZone: string },
  work: (service: Pick<AssistanceService, 'create'>) => Promise<AssistanceRequest>,
) => Promise<AssistanceRequest>;

interface AssistanceAdapterDependencies {
  readonly trustedIdentity?: () => Identity | undefined;
  readonly encryptionKey?: () => string | undefined;
  readonly timeZone?: () => string;
  readonly run?: AssistanceServiceRunner;
}

/** Maps the authenticated concierge session onto WP-014 without accepting client authority. */
export function createPostgresConciergeAssistanceAdapter(
  dependencies: AssistanceAdapterDependencies = {},
): AssistanceCreationPort {
  const identityForRequest = dependencies.trustedIdentity ?? (() => trustedAssistanceIdentity.getStore());
  const encryptionKey = dependencies.encryptionKey ?? (() => process.env.ASSISTANCE_ENCRYPTION_KEY);
  const timeZone = dependencies.timeZone ?? (() => loadConfig().branding.cityTimezone);
  const run = dependencies.run ?? ((configuration, work) => withPostgresAssistanceService(configuration, work));
  return {
    create: async input => {
      const identity = identityForRequest();
      if (!identity || identity.orgId !== input.orgId || identity.userId !== input.actorId) {
        throw new Error('trusted concierge identity is required');
      }
      const key = encryptionKey();
      if (!key) throw new Error('ASSISTANCE_ENCRYPTION_KEY is required');
      if (!isCanonicalAssistanceEncryptionKey(key)) {
        throw new Error('ASSISTANCE_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
      }
      const request = await run({ encryptionKey: key, timeZone: timeZone() }, service => service.create(identity, {
        summary: input.summary,
        locale: input.locale,
        idempotencyKey: input.idempotencyKey,
      }));
      return presentAssistance(request);
    },
  };
}

export function isCanonicalAssistanceEncryptionKey(value: string): boolean {
  if (!/^[A-Za-z0-9+/]{43}=$/u.test(value)) return false;
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === 32 && decoded.toString('base64') === value;
}

function presentAssistance(request: AssistanceRequest): AssistanceRequestRecord {
  return {
    id: request.id,
    org_id: request.orgId,
    state: request.state,
    summary: request.summary,
    triage_category: request.triageCategory,
    triage_source: request.triageSource,
    owner_id: request.ownerId,
    sla_due_at: request.slaDueAt.toISOString(),
    after_hours: request.afterHours,
  };
}

const postgresAssistance = createPostgresConciergeAssistanceAdapter();

const defaults: RuntimeAdapters = { authorize: sessionAuthorize, directory, ai, aiAvailability, assistance: postgresAssistance };
const adapters: RuntimeAdapters = { ...defaults };
const PROCESS_LOCAL_STORE = Symbol.for('@seniorsocial/web.concierge.conversation-store.v1');
interface ProcessLocalStoreSlot {
  readonly version: 1;
  readonly store: InMemoryConversationStore;
}

function isCompatibleProcessLocalStore(value: unknown): value is InMemoryConversationStore {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return ['create', 'get', 'save', 'getOrCreateHandoff', 'clear']
    .every(method => typeof candidate[method] === 'function');
}

/**
 * Test-only continuity across independently compiled Next route graphs. Production uses the
 * PostgreSQL store below; this process-local store keeps zero-database route tests isolated.
 */
function processLocalConversationStore(): InMemoryConversationStore {
  const scope = globalThis as unknown as Record<PropertyKey, unknown>;
  const existing = scope[PROCESS_LOCAL_STORE];
  if (existing !== undefined) {
    const slot = existing as Partial<ProcessLocalStoreSlot>;
    if (slot.version !== 1 || !isCompatibleProcessLocalStore(slot.store)) {
      throw new Error('incompatible concierge process-local store');
    }
    return slot.store;
  }
  const slot: ProcessLocalStoreSlot = { version: 1, store: new InMemoryConversationStore() };
  Object.defineProperty(scope, PROCESS_LOCAL_STORE, { value: slot, configurable: false, enumerable: false, writable: false });
  return slot.store;
}

const testStore = process.env.NODE_ENV === 'test' ? processLocalConversationStore() : undefined;
let conversationClient: ReturnType<typeof createDatabaseClient> | undefined;
function conversationDatabase() {
  conversationClient ??= createDatabaseClient();
  return conversationClient;
}
const store: ConversationStore = testStore ?? new PostgresConversationStore(conversationDatabase);
class RuntimeConciergeService extends ConciergeService {
  override handoff(session: ConciergeSession, id: string): Promise<AssistanceRequestRecord | null> {
    const identity: Identity = { orgId: session.orgId, userId: session.userId, roles: [session.role] };
    return trustedAssistanceIdentity.run(identity, () => super.handoff(session, id));
  }
}

const concierge = new RuntimeConciergeService({
  conversations: store,
  directory: { search: input => adapters.directory.search(input) },
  ai: { chat: input => adapters.ai.chat(input) },
  aiAvailability: { enabled: orgId => adapters.aiAvailability.enabled(orgId) },
  assistance: { create: input => adapters.assistance.create(input) },
});

export const conciergeRouteDependencies: ConciergeRouteDependencies = {
  authorize: request => adapters.authorize(request), concierge,
};

/** Allows another server composition root to replace the WP-014 adapter. */
export function registerConciergeAssistance(adapter: AssistanceCreationPort): void { adapters.assistance = adapter; }

/** Test-only registry hook used to smoke-test the actual exported route handlers without a network or database. */
export function registerConciergeRuntimeForTest(overrides: Partial<RuntimeAdapters>): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('concierge runtime overrides are test-only');
  Object.assign(adapters, overrides);
}

export function resetConciergeRuntimeForTest(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('concierge runtime overrides are test-only');
  Object.assign(adapters, defaults);
  testStore?.clear();
  gatewayPromise = undefined;
}

function localeCookie(request: Request): ConciergeSession['locale'] {
  return readCookie(request, 'seniorsocial.locale.v1') === 'es' ? 'es' : 'en';
}
