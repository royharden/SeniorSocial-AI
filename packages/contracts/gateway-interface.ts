/**
 * SeniorSocial LLM gateway — CONTRACT SPEC.
 *
 * Declarations only. This file is not product code and ships no implementation.
 * `packages/ai` implements it; every AI feature imports the types from
 * `packages/ai` and calls `ai.*`. No feature constructs a provider request
 * directly, which is what makes every call flagged, logged, rate-limited,
 * cached and killable.
 *
 * Change rule: integrator only, via a ruled docket. Bump CONTRACT_VERSION with
 * any change and reopen every merged package that touches the AI surface.
 *
 * Spine reference: §9 (gateway and cost), §9a (provider policy).
 */

export declare const CONTRACT_VERSION: 2;

/* ------------------------------------------------------------------ *
 * Features                                                            *
 * ------------------------------------------------------------------ */

/**
 * The closed set of AI features. Each maps 1:1 to a kill switch in
 * feature-flags.md (`ai.<feature>`) and to a prompt folder at
 * `packages/ai/prompts/<feature>/v<N>.md`.
 *
 * Adding a feature means adding a flag, a prompt folder, an eval folder
 * and a defined non-AI path. All four, or the feature does not exist.
 */
export type AiFeature =
  | 'concierge'
  | 'moderation'
  | 'translation_assist'
  | 'triage'
  | 'intake_routing'
  | 'event_rerank'
  | 'conversation_starters'
  | 'summaries';

/** Prompt registry key: `packages/ai/prompts/<feature>/v<N>.md` plus its sha256. */
export interface PromptRef {
  readonly feature: AiFeature;
  /** e.g. "v3" */
  readonly version: string;
  /** sha256 of the prompt text, so an ai_events row resolves to exact text (AI-6, AI-7). */
  readonly hash: string;
}

/* ------------------------------------------------------------------ *
 * Calling context — required on every call                            *
 * ------------------------------------------------------------------ */

/**
 * Every gateway call carries who it is for. There is no anonymous call:
 * without org_id the event log cannot be scoped, and without user_role the
 * rate limiter and the audit trail cannot do their jobs.
 */
export interface AiContext {
  readonly orgId: string;
  readonly userId: string;
  readonly userRole: 'senior' | 'caregiver' | 'staff' | 'admin' | 'partner' | 'support';
  /** Set when a caregiver is acting under consent; recorded as on_behalf_of. */
  readonly onBehalfOf?: string;
  readonly locale: 'en' | 'es';
  /** Correlates the AI event with the request and the audit event. */
  readonly requestId: string;
}

/* ------------------------------------------------------------------ *
 * Messages and tools                                                  *
 * ------------------------------------------------------------------ */

export interface AiMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool_result';
  readonly content: string;
  /** Present on tool_result only. */
  readonly toolCallId?: string;
}

/**
 * The tool allowlist is per feature and closed. The concierge may call
 * exactly searchDirectory, listEvents and proposeAssistanceRequest — nothing
 * else is reachable, which is the egress control, not a guideline.
 *
 * Tool *execution* always happens in application code. The model proposes;
 * the app decides, executes, and returns the result as a tool_result message.
 * A model never reaches the database or the network.
 */
export interface AiToolSpec {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the arguments. Strict mode where the provider supports it. */
  readonly parameters: Readonly<Record<string, unknown>>;
}

/**
 * The assistance tool returns a PROPOSAL. It writes nothing.
 *
 * Round 1 named this tool `openAssistanceRequest`, and the verb was the bug:
 * a tool named for the act invites an implementation in which the model's
 * tool call IS the act. The rename is the fix, and these three rules are what
 * the rename buys (08-llm-gateway-and-cost.md 1.1):
 *
 *   1. No operational table is touched here. This is data the app renders.
 *   2. The RESIDENT confirms, authenticated, in the native app: the proposal
 *      renders as a filled-in form they read, edit and submit. A caregiver
 *      acting under consent confirms as themselves and the request records
 *      on_behalf_of.
 *   3. Submission goes to a policy-checked, IDEMPOTENT endpoint
 *      (POST /api/v1/assistance with idempotencyKey) that re-runs role,
 *      consent-scope and org_id checks from scratch. The endpoint trusts the
 *      proposal for CONTENT, never for AUTHORITY.
 *
 * AI never triggers a send — not a request, not a ride, not a message, not an
 * alert. A model that DESCRIBES a proposal as already submitted is a copy
 * failure with the consequences of an authority failure, and the eval set
 * fails it (evals/seed-cases/prompt-injection-resistance.yaml).
 */
export interface AssistanceProposal {
  readonly kind: 'assistance_request_proposal';
  /** From the closed intake enum. Never free text. */
  readonly category: string;
  /** The model's words, shown to the resident verbatim before they confirm. */
  readonly summary: string;
  readonly urgency: 'routine' | 'soon' | 'priority';
  /** Pre-filled and fully editable by the person confirming. */
  readonly proposedFields: Readonly<Record<string, unknown>>;
  /** Minted here, spent once by the native endpoint. A replay creates one request. */
  readonly idempotencyKey: string;
  /** Rendered with the proposal. "Nothing has been sent yet." */
  readonly disclaimer: string;
}

export interface AiToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

/* ------------------------------------------------------------------ *
 * Results                                                             *
 * ------------------------------------------------------------------ */

/**
 * `killed` is a first-class outcome, not an error. When a kill switch is off
 * the call returns killed with a humanRoute, and the caller renders the
 * non-AI path. A feature that throws on killed has not implemented AI-8.
 */
export type AiOutcome =
  | 'ok'
  | 'refused'
  | 'error'
  | 'killed'
  /**
   * The egress guard found a server-only fixture or a canary token in the
   * ACTUAL outbound request body and refused the call. Nothing left the
   * process. Distinct from 'error' because it is a control firing correctly,
   * and distinct from 'refused' because the model was never consulted.
   */
  | 'egress_blocked';

export interface AiResultBase {
  readonly outcome: AiOutcome;
  /** Present unless outcome is 'killed'. */
  readonly promptRef?: PromptRef;
  /** The id of the ai_events row this call wrote. Always present. */
  readonly eventId: string;
  /** What the person can do instead. Required when outcome is 'killed' or 'refused'. */
  readonly humanRoute?: string;
  /** Why, in one line. Required when outcome is 'refused' or 'error'. */
  readonly reason?: string;
  readonly cacheHit: boolean;
}

export interface AiChatResult extends AiResultBase {
  readonly text: string;
  readonly toolCalls: readonly AiToolCall[];
  /** Present when a schema was supplied and the response validated against it. */
  readonly structured?: unknown;
  /**
   * Grounding citations the caller must render. For the concierge these are
   * directory record ids; an answer with an empty array must say it does not
   * know rather than answer from the model's own knowledge.
   */
  readonly citations: readonly string[];
}

export interface AiClassifyResult<L extends string = string> extends AiResultBase {
  readonly label: L;
  readonly confidence: number;
  /** Set when a deterministic detector decided before any model was called. */
  readonly deterministic: boolean;
}

export interface AiTranslateResult extends AiResultBase {
  readonly text: string;
  /**
   * Always true for gateway output. Translation produced here is a DRAFT.
   * Critical copy cannot publish without a recorded human approval
   * (i18n-namespaces.md §3, SC-05, D-05, A-5).
   */
  readonly machineGenerated: true;
  readonly sourceVersion: string;
}

export interface AiSummarizeResult extends AiResultBase {
  readonly text: string;
  /** The record version the summary was generated from. A stale summary must
   *  never overwrite newer human work (SC-04, Q1-21). */
  readonly baseVersion: string;
}

export interface AiEmbedResult extends AiResultBase {
  readonly vectors: readonly (readonly number[])[];
  readonly dimensions: number;
  readonly model: string;
}

/* ------------------------------------------------------------------ *
 * The ai.* surface                                                    *
 * ------------------------------------------------------------------ */

export interface AiChatRequest {
  readonly feature: AiFeature;
  readonly context: AiContext;
  readonly messages: readonly AiMessage[];
  readonly tools?: readonly AiToolSpec[];
  /** JSON Schema. Uses the provider's native structured-output mode where available. */
  readonly schema?: Readonly<Record<string, unknown>>;
  readonly maxTokens?: number;
  /** Default 0 for anything a resident sees. Determinism beats flair here. */
  readonly temperature?: number;
}

export interface AiClassifyRequest<L extends string = string> {
  readonly feature: AiFeature;
  readonly context: AiContext;
  readonly input: string;
  readonly labels: readonly L[];
}

export interface AiTranslateRequest {
  readonly feature: 'translation_assist';
  readonly context: AiContext;
  readonly text: string;
  readonly from: 'en';
  readonly to: 'es';
  readonly sourceVersion: string;
  /** When true the gateway still returns a draft, and the caller must not publish it. */
  readonly critical: boolean;
}

export interface AiSummarizeRequest {
  readonly feature: 'summaries';
  readonly context: AiContext;
  readonly text: string;
  readonly baseVersion: string;
}

export interface AiEmbedRequest {
  readonly feature: AiFeature;
  readonly context: AiContext;
  readonly inputs: readonly string[];
}

/**
 * The whole AI surface of the product. Five methods. Every one of them:
 *   - checks `ai.master` and `ai.<feature>` and returns `killed` if either is off;
 *   - checks the per-user and per-feature rate limit and throws AiRateLimited;
 *   - consults the exact-match cache under the boundary in CacheKey below,
 *     and RE-AUTHORIZES any hit against current grants before it is rendered;
 *   - runs the egress guard on the ACTUAL outbound request body before every
 *     provider call — main, fallback, tool round and judge alike — and refuses
 *     the call outright when a server-only fixture or canary token is present
 *     (outcome 'egress_blocked'). Post-call log redaction is not an egress
 *     control: by the time a redactor sees a payload, the provider has it;
 *   - writes exactly one AiEvent, including on cache hit, refusal and kill;
 *   - never throws for a refusal — a refusal is a result, and the caller renders it.
 */
export interface AiGateway {
  chat(req: AiChatRequest): Promise<AiChatResult>;
  classify<L extends string>(req: AiClassifyRequest<L>): Promise<AiClassifyResult<L>>;
  translate(req: AiTranslateRequest): Promise<AiTranslateResult>;
  summarize(req: AiSummarizeRequest): Promise<AiSummarizeResult>;
  embed(req: AiEmbedRequest): Promise<AiEmbedResult>;
}

export declare class AiRateLimited extends Error {
  readonly retryAfterSeconds: number;
}

/* ------------------------------------------------------------------ *
 * Cache boundary                                                      *
 * ------------------------------------------------------------------ */

/**
 * A response cache is an authorization bypass with a friendly name unless its
 * boundary is written down: a cached answer is, by construction, an answer
 * computed for someone else's authorization state at an earlier time.
 *
 * THE MVP CACHES ONLY responses built entirely from approved public directory
 * and FAQ content. No consent-scoped data, no resident-specific data, and
 * CAREGIVER-SCOPED ANSWERS ARE NEVER CACHED IN THE MVP. The gateway carries a
 * taint bit on the render: reading anything under a grant marks the response
 * non-cacheable at the point of the read, rather than leaving it to a feature
 * author to remember later.
 *
 * Rules the implementation must honour (08-llm-gateway-and-cost.md 1.5):
 *  - Every hit is RE-AUTHORIZED against current grants before render. The
 *    cache returns content; the feature module still runs its policy check in
 *    this session, now. A hit that skipped the check would be a permission
 *    that outlived its grant.
 *  - Invalidation is EVENT-DRIVEN: a directory or FAQ edit, a consent or grant
 *    change, a prompt-version bump, or a model change invalidates immediately.
 *    ttlHours (24 for the concierge) is a CEILING and a backstop for an
 *    invalidation we failed to wire — never the mechanism.
 *  - Normalization is LOSSLESS: whitespace trimming only. No lowercasing, no
 *    punctuation stripping. Case distinguishes proper nouns and a trailing '?'
 *    is the difference between "no ride" and "no ride?"; two different
 *    questions must never collide onto one cached answer.
 *  - No semantic caching. A near-match cache is a wrong-answer cache.
 */
export interface CacheKey {
  readonly orgId: string;
  readonly locale: AiContext['locale'];
  readonly feature: AiFeature;
  readonly promptVersion: string;
  readonly model: string;
  /**
   * The sorted set of (entityType, entityId, version) for every directory
   * entry, FAQ and policy page that went into the answer. This is what makes
   * staleness impossible rather than unlikely: a source version changes, the
   * key stops matching, and the old answer is unreachable.
   */
  readonly sourceContentVersionSet: readonly string[];
  /** sha256 over the whitespace-trimmed input. Nothing else is normalised. */
  readonly inputHash: string;
}

export interface CacheEntry {
  readonly key: CacheKey;
  readonly hitCount: number;
  /** Ceiling only. Event-driven invalidation is the real mechanism. */
  readonly expiresAt: string;
  /** False for anything a grant was read to produce. Never cached. */
  readonly cacheable: true;
}

/* ------------------------------------------------------------------ *
 * Provider adapters                                                   *
 * ------------------------------------------------------------------ */

export type AiProviderId =
  /** Deterministic fixtures. The default in dev, the ONLY value in test and CI. */
  | 'stub'
  /** Default from T+0 for anything real. Haiku for volume, Sonnet where quality demands. */
  | 'anthropic-api'
  /** Backup. */
  | 'openai-api'
  /**
   * Documented design option, OFF in every environment (feature-flags.md §2).
   * Anthropic's published policy reserves OAuth subscription credentials for
   * ordinary use of Claude Code and native applications and directs product
   * developers to API keys (spine §9a). Never serves tests, other agents'
   * sessions, reviewers, or anything deployed.
   */
  | 'claude-cli-bridge'
  /** Same status as claude-cli-bridge, as a backup. */
  | 'codex-cli-bridge';

export interface AiProviderCapabilities {
  readonly tools: boolean;
  readonly structuredOutputs: boolean;
  readonly streaming: boolean;
  readonly embeddings: boolean;
  readonly batch: boolean;
  readonly promptCaching: boolean;
  readonly maxConcurrency: number;
  readonly timeoutMs: number;
  /**
   * Per-model sampling/thinking schema (adopted in cycle 3 from the peer's 08 "Provider phases and
   * verified constraint"). Sonnet 5's thinking and sampling parameters differ from Haiku 4.5's; the
   * gateway NEVER forwards a generic `temperature` or a Haiku thinking budget to a model whose schema
   * does not accept it. The adapter maps the gateway's abstract request onto the model's schema and
   * rejects (does not silently drop) a parameter the model cannot honour; a rejected parameter is a
   * typed error the eval suite catches, not a quietly different answer.
   */
  readonly samplingSchema: 'anthropic-haiku-4-5' | 'anthropic-sonnet-5' | 'anthropic-opus-5' | 'openai-chat' | 'voyage-embed' | 'stub';
  readonly acceptsTemperature: boolean;
  readonly acceptsThinkingBudget: boolean;
  /**
   * MUST be true for every adapter. The provider SDK's own automatic retries
   * are DISABLED — `new Anthropic({ maxRetries: 0 })`, `new OpenAI({
   * maxRetries: 0 })`, and the equivalent on any adapter added later.
   *
   * Both SDKs retry by default (typically twice: connection errors, 408, 409,
   * 429, 5xx, with backoff). Those attempts are invisible to the gateway: it
   * made one call, it will settle one usage block, and two or three requests
   * were billed against a reservation computed for one. A cap that cannot see
   * the attempts it is capping is a cap-shaped number in a dashboard.
   *
   * Retry policy lives in exactly one place — the gateway (see
   * GatewayRetryPolicy below) — so that every attempt is inside the reserved
   * envelope and the total deadline. An adapter is a translation layer; it
   * does not decide how many times a request happens, any more than it decides
   * whether the request is allowed at all.
   *
   * Asserted by a unit test on adapter CONSTRUCTION, not by code review: the
   * SDK default is non-zero and the failure mode is silent.
   */
  readonly sdkRetriesDisabled: true;
}

/**
 * Gateway-owned retry policy (08 §1.7). One place, one envelope, one deadline.
 *
 * The reservation's enforced maximum covers ALL attempts: the first call, the
 * single retry, every tool round, the fallback model the routing table may
 * reach for, and any judge call the feature makes. With `sdkRetriesDisabled`
 * on every adapter, the number of outbound requests attributable to one
 * reservation is bounded by (1 + maxGatewayRetries) x (tool rounds + fallback
 * + judge) — all of it inside the reserved envelope. With the SDK default it
 * is bounded by nothing the gateway can observe, which is the whole point.
 */
export interface GatewayRetryPolicy {
  /**
   * At most ONE explicit retry, performed by the gateway, inside the SAME
   * reservation. One rather than three: a civic service that answers slowly is
   * worse than one that fails honestly to its human fallback, and the second
   * attempt is where most recoverable failures are recovered.
   */
  readonly maxGatewayRetries: 0 | 1;
  /**
   * The whole envelope shares ONE deadline. A retry does not get a fresh
   * timeout; a request that has spent its deadline goes to its fallback rather
   * than trying again more slowly.
   */
  readonly totalDeadlineMs: number;
  /** Retries settle against this reservation. They never take a new one. */
  readonly reservationId: string;
}

export interface AiProviderUsage {
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly tokensCached: number;
}

export interface AiProviderResponse {
  readonly text: string;
  readonly toolCalls: readonly AiToolCall[];
  readonly structured?: unknown;
  readonly usage: AiProviderUsage;
  readonly model: string;
  readonly latencyMs: number;
}

/**
 * An adapter is a thin translation layer and nothing else. It does not read
 * flags, does not write events, does not cache, does not rate-limit and does
 * not decide policy — the gateway does all of that, once, for every provider.
 * An adapter that starts making decisions is how two providers end up with
 * two different safety behaviours.
 */
export interface AiProviderAdapter {
  readonly id: AiProviderId;
  readonly capabilities: AiProviderCapabilities;
  complete(input: {
    readonly system: string;
    readonly messages: readonly AiMessage[];
    readonly tools?: readonly AiToolSpec[];
    readonly schema?: Readonly<Record<string, unknown>>;
    readonly maxTokens?: number;
    readonly temperature?: number;
    readonly signal: AbortSignal;
  }): Promise<AiProviderResponse>;
  embed?(inputs: readonly string[]): Promise<{
    readonly vectors: readonly (readonly number[])[];
    readonly dimensions: number;
    readonly model: string;
    readonly usage: AiProviderUsage;
  }>;
}

/* ------------------------------------------------------------------ *
 * The event record                                                    *
 * ------------------------------------------------------------------ */

/**
 * One row in `ai_events` per gateway call — including cache hits, refusals
 * and kills. Append-only at the database level. This table plus pricing.yml
 * is the cost dashboard the staff admin sees, and the evidence for AI-2,
 * AI-6 and AI-7.
 *
 * What promptVersion + promptHash + model + provider preserve is the
 * CONFIGURATION a complained-about answer was produced under — what the
 * system was set up to do when it said that. They do NOT make the output
 * reproducible: these models are stochastic, and re-running the same input
 * under the same recorded configuration can produce different text. Claiming
 * exact reproducibility would be a promise the architecture cannot keep.
 */
export interface AiEvent {
  readonly id: string;
  readonly orgId: string;
  readonly requestId: string;
  readonly feature: AiFeature;
  readonly promptVersion: string | null;
  readonly promptHash: string | null;
  readonly provider: AiProviderId;
  readonly model: string;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly tokensCached: number | null;
  readonly latencyMs: number;
  readonly cacheHit: boolean;
  readonly userRole: AiContext['userRole'];
  readonly onBehalfOf: string | null;
  readonly outcome: AiOutcome;
  /** Present for 'refused', 'error' and 'killed'. Never contains user content. */
  readonly reason: string | null;
  /** Computed from packages/ai/pricing.yml at write time. Never estimated later. */
  readonly costUsd: number;
  /**
   * The reservation this call spent against (see CostReservation below).
   * Null ONLY for cache hits and the stub provider, which make no outbound
   * attempt and therefore reserve nothing. Every other event has one, so
   * reserved-but-unsettled spend is queryable: a provider outage leaves live
   * reservations, and an operator must see them as held money, not as nothing.
   */
  readonly reservationId: string | null;
  /**
   * The settled cost. When usageKnown is false this carries the RESERVED
   * UPPER BOUND, never 0. A zero that means "we do not know" is the number
   * that gets summed into a false total. Null only while a reservation is
   * still pending reconciliation after an ambiguous timeout.
   */
  readonly settledUsd: number | null;
  /**
   * False when the provider returned no usage block. The token fields are
   * then null (never 0), costBasis is 'estimated', and the admin tiles show
   * the row in the estimated column rather than in the metered total.
   */
  readonly usageKnown: boolean;
  readonly createdAt: string;
}

/* ------------------------------------------------------------------ *
 * Cost reservation                                                    *
 * ------------------------------------------------------------------ */

/**
 * Reserve first, settle once. Every cap — per feature, per org per day,
 * per org total — is checked against a reservation taken BEFORE the outbound
 * attempt, in ONE SQL transaction that both re-reads the caps and inserts the
 * reservation. Settlement after the fact cannot enforce a cap: eight
 * concurrent requests all read the same counter, all see headroom, and all
 * proceed. The transaction is what makes the second request see the first
 * request's reservation.
 *
 * Rules the implementation must honour (08-llm-gateway-and-cost.md 1.7):
 *  - reservedUsd is the UPPER bound of the whole envelope: the first attempt,
 *    the single gateway retry (GatewayRetryPolicy), every tool round the
 *    request may make, any fallback model the routing table could reach for,
 *    and any judge call. A retry and a fallback settle against the SAME
 *    reservation; they never take a new one.
 *  - The SDK's own retries are OFF in every adapter
 *    (AiProviderCapabilities.sdkRetriesDisabled). This is what makes the
 *    envelope true rather than assumed: a hidden SDK send can never exceed the
 *    bound, because there are no hidden sends. With the SDK default, one
 *    reservation could be spent two or three times over and the meter would
 *    report a single call.
 *  - Settlement is idempotent by id. A duplicated completion callback can
 *    neither double-charge nor double-refund.
 *  - An ambiguous timeout HOLDS the reservation as 'pending_reconciliation'.
 *    The call may or may not have been billed, and the honest state is
 *    unknown, not free. Releasing it would let a flapping provider mint
 *    budget. A reconciliation job settles it against the provider's own usage
 *    report where one exists; otherwise it expires at AI_RESERVATION_TTL_MIN
 *    and is written off at reservedUsd with usageKnown false. Disabling SDK
 *    retries surfaces timeouts the SDK used to swallow, so this path is now
 *    load-bearing rather than rare.
 */
export type CostReservationState =
  | 'held'
  | 'settled'
  | 'released'
  | 'pending_reconciliation'
  | 'expired';

export interface CostReservation {
  readonly id: string;
  readonly orgId: string;
  readonly feature: AiFeature;
  readonly requestId: string;
  /** Upper bound in USD: maxOutputTokens * price.output + measured input. */
  readonly reservedUsd: number;
  /** The ceiling the upper bound was computed from, for later audit. */
  readonly maxOutputTokens: number;
  readonly state: CostReservationState;
  readonly createdAt: string;
  /** Set on settle, release or expiry; null while held. */
  readonly closedAt: string | null;
  /** Present once settled; equals reservedUsd when usage was never reported. */
  readonly settledUsd: number | null;
  /**
   * Every outbound attempt made against this reservation, in order, so the
   * envelope can be audited rather than trusted: the first call, the gateway
   * retry if there was one, each tool round, the fallback, the judge. An
   * attempt that is not in this list did not happen — which is only a true
   * statement because sdkRetriesDisabled removes the layer that could have
   * made one without telling anybody.
   */
  readonly attempts: readonly {
    readonly kind: 'initial' | 'gateway-retry' | 'tool-round' | 'fallback' | 'judge';
    readonly model: string;
    readonly startedAt: string;
    readonly usage: AiProviderUsage | null;
  }[];
}

/**
 * NOT IN THIS RECORD, DELIBERATELY: prompt text, user input, model output.
 * Full input/output logging is a separate, flag-gated, retention-bounded
 * store with its own access control (S-2, S-4, S-10). Putting resident
 * content in the metrics table is how a cost dashboard becomes a data-breach
 * surface. `promptHash` plus `requestId` is enough to reconstruct any call
 * for review through the audited path.
 */

/*
 * Signed: 0120_Claude_Opus5_Sub_Planning2_GatewayCost
 * Revised for output-002 by 0124_Claude_Opus5_Sub_Planning2_Reviser under
 * 0106_Claude_Fable_Phase2Planner: added reservationId, settledUsd and
 * usageKnown to AiEvent, plus CostReservation and CostReservationState
 * (08 section 1.7, adopted from the peer lane's 08 "Cost math and caps").
 * Revised for output-002 by 0126_Claude_Opus5_Sub_Planning2_ReviserB2 under
 * 0106_Claude_Fable_Phase2Planner (peer review R1-11, R1-12): renamed the
 * assistance tool to proposeAssistanceRequest and added AssistanceProposal;
 * added the 'egress_blocked' outcome and the pre-call egress-guard rule on
 * the AiGateway surface; added CacheKey / CacheEntry with the public-content
 * cache boundary, re-authorization on every hit, event-driven invalidation
 * and lossless normalization; stated what a prompt hash does and does not
 * prove.
 *
 * Revised for output-003 by 0129_Claude_Opus5_Sub_Planning2_Reviser3 under
 * 0106_Claude_Fable_Phase2Planner (peer review R2-10): added
 * AiProviderCapabilities.sdkRetriesDisabled (the provider SDK's automatic
 * retries are off in every adapter, asserted at construction), the
 * GatewayRetryPolicy surface (at most one gateway-owned retry, inside the same
 * reservation and one total deadline), and CostReservation.attempts so the
 * reserved envelope can be audited rather than trusted; restated the
 * ambiguous-timeout path as usage_known=false at the reserved upper bound with
 * a reconciliation job.
 *
 * CONTRACT_VERSION stays 1: this file has not been landed by WP-002 yet, so
 * there is no merged package to reopen. The bump-and-reopen rule applies from
 * the moment the integrator first lands agentops/interfaces/, not before.
 *
 * Revised after WP-006 integration for WP-008: CONTRACT_VERSION 2 makes the
 * AiEvent token fields nullable when usageKnown is false. Unknown usage is
 * represented as null, never as a misleading zero; provider response usage
 * remains numeric when a provider supplies a usage block.
 */
