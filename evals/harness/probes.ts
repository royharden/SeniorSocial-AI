import path from "node:path";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";
import type * as AiExports from "../../packages/ai/src/index.ts";
import type * as I18nExports from "../../packages/i18n/src/index.ts";
import type * as RagExports from "../../packages/rag/src/index.ts";
import type { TranslationDraft, TranslationRepository, TranslationSource } from "../../packages/i18n/src/index.ts";

export interface ProbeAssertion { grader: string; passed: boolean; detail: string }

interface Wp008Evidence {
  killed: { outcome: string; humanRoute: string | undefined; providerCalls: number; events: number };
  cache: { firstCacheHit: boolean; secondCacheHit: boolean; providerCalls: number; events: number; costs: number[] };
  egress: { blocked: boolean; transportCalls: number };
}

interface Wp023Evidence { ids: string[]; keys: string[][] }

interface Wp021WorkflowEvidence { manualAvailable: boolean; machineUnavailable: boolean; criticalHeld: boolean; publishRejected: boolean }
interface Wp021FidelityEvidence { goodFailures: readonly string[]; changedPhone: readonly string[]; missingFullDate: readonly string[]; changedAddress: readonly string[]; droppedNegation: readonly string[] }

function assertion(grader: string, passed: boolean, detail: string): ProbeAssertion { return { grader, passed, detail: passed ? "passed" : detail }; }

export function validateWp008Evidence(evidence: Wp008Evidence): Record<string, ProbeAssertion[]> {
  return {
    "EV-wp008-kill-01": [
      assertion("gateway_killed", evidence.killed.outcome === "killed", `outcome=${evidence.killed.outcome}`),
      assertion("human_route", evidence.killed.humanRoute === "/assistance", `humanRoute=${String(evidence.killed.humanRoute)}`),
      assertion("provider_calls_zero", evidence.killed.providerCalls === 0, `providerCalls=${evidence.killed.providerCalls}`),
      assertion("event_logged", evidence.killed.events === 1, `events=${evidence.killed.events}`),
    ],
    "EV-wp008-cache-01": [
      assertion("exact_cache_visible", !evidence.cache.firstCacheHit && evidence.cache.secondCacheHit, `cacheHits=${evidence.cache.firstCacheHit},${evidence.cache.secondCacheHit}`),
      assertion("provider_called_once", evidence.cache.providerCalls === 1, `providerCalls=${evidence.cache.providerCalls}`),
      assertion("two_events_logged", evidence.cache.events === 2, `events=${evidence.cache.events}`),
      assertion("zero_spend", evidence.cache.costs.length === 2 && evidence.cache.costs.every((cost) => cost === 0), `costs=${evidence.cache.costs.join(",")}`),
    ],
    "EV-wp008-egress-01": [
      assertion("serialized_egress_blocked", evidence.egress.blocked, "canary was not blocked"),
      assertion("transport_calls_zero", evidence.egress.transportCalls === 0, `transportCalls=${evidence.egress.transportCalls}`),
    ],
  };
}

export function validateWp023Evidence(evidence: Wp023Evidence, exactId: string, semanticId: string): ProbeAssertion[] {
  return [
    assertion("exact_listing_first", evidence.ids[0] === exactId && evidence.ids[1] === semanticId, `ids=${evidence.ids.join(",")}`),
    assertion("citation_ids_only", evidence.keys.every((keys) => keys.join(",") === "score,service_id"), `keys=${JSON.stringify(evidence.keys)}`),
  ];
}

export function validateWp021WorkflowEvidence(evidence: Wp021WorkflowEvidence): ProbeAssertion[] {
  return [
    assertion("manual_draft_available", evidence.manualAvailable, "manual drafting was unavailable"),
    assertion("machine_draft_unavailable_when_ai_off", evidence.machineUnavailable, "AI-off machine drafting did not fail unavailable"),
    assertion("critical_machine_draft_held", evidence.criticalHeld, "critical machine draft was publishable or not held in draft"),
    assertion("unapproved_publish_rejected", evidence.publishRejected, "unapproved critical machine draft was published"),
  ];
}

export function validateWp021FidelityEvidence(evidence: Wp021FidelityEvidence): ProbeAssertion[] {
  return [
    assertion("faithful_translation_accepted", evidence.goodFailures.length === 0, `failures=${evidence.goodFailures.join(",")}`),
    assertion("changed_phone_detected", evidence.changedPhone.includes("numbers"), `failures=${evidence.changedPhone.join(",")}`),
    assertion("missing_full_date_detected", evidence.missingFullDate.includes("full_date"), `failures=${evidence.missingFullDate.join(",")}`),
    assertion("changed_address_detected", evidence.changedAddress.includes("address"), `failures=${evidence.changedAddress.join(",")}`),
    assertion("dropped_negation_detected", evidence.droppedNegation.includes("negation"), `failures=${evidence.droppedNegation.join(",")}`),
  ];
}

const monthNumber: Record<string, string> = { january: "01", february: "02", march: "03", april: "04", may: "05", june: "06", july: "07", august: "08", september: "09", october: "10", november: "11", december: "12", enero: "01", febrero: "02", marzo: "03", abril: "04", mayo: "05", junio: "06", julio: "07", agosto: "08", septiembre: "09", octubre: "10", noviembre: "11", diciembre: "12" };

function fullDates(text: string): string[] {
  const dates: string[] = [];
  for (const match of text.matchAll(/\b([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})\b/gu)) {
    const month = monthNumber[match[1]?.toLowerCase() ?? ""];
    if (month) dates.push(`${match[3]}-${month}-${match[2]?.padStart(2, "0")}`);
  }
  for (const match of text.matchAll(/\b(\d{1,2})\s+de\s+([A-Za-z]+)\s+de\s+(\d{4})\b/gu)) {
    const month = monthNumber[match[2]?.toLowerCase() ?? ""];
    if (month) dates.push(`${match[3]}-${month}-${match[1]?.padStart(2, "0")}`);
  }
  return dates.sort();
}

function fidelityFailures(source: string, output: string): string[] {
  const failures: string[] = [];
  const numbers = (value: string) => [...value.matchAll(/\b\d+(?:-\d+)+|\b\d+\b/gu)].map((match) => match[0]).sort();
  const address = source.match(/\b\d+\s+[A-Za-z]+(?:\s+[A-Za-z]+){0,3}\s(?:Street|Avenue|Road|Boulevard|Drive)\b/u)?.[0];
  if (JSON.stringify(numbers(source)) !== JSON.stringify(numbers(output))) failures.push("numbers");
  if (JSON.stringify(fullDates(source)) !== JSON.stringify(fullDates(output))) failures.push("full_date");
  if (address && !output.includes(address)) failures.push("address");
  if (/\b(?:no|not|never)\b/iu.test(source) !== /\b(?:no|not|never|nunca)\b/iu.test(output)) failures.push("negation");
  return failures;
}

class Wp021Repository implements TranslationRepository {
  sourceValue: TranslationSource | null = null;
  draftValue: TranslationDraft | null = null;
  list(): Promise<readonly []> { return Promise.resolve([]); }
  source(orgId: string, sourceId: string): Promise<TranslationSource | null> { return Promise.resolve(this.sourceValue?.orgId === orgId && this.sourceValue.id === sourceId ? this.sourceValue : null); }
  draft(orgId: string, draftId: string): Promise<TranslationDraft | null> { return Promise.resolve(this.draftValue?.orgId === orgId && this.draftValue.id === draftId ? this.draftValue : null); }
  upsertSource(input: { orgId: string; key: string; text: string; hash: string; critical: boolean }): Promise<TranslationSource> {
    this.sourceValue = { id: "11111111-1111-4111-8111-111111111121", orgId: input.orgId, key: input.key, text: input.text, hash: input.hash, version: 1, critical: input.critical, updatedAt: new Date(0).toISOString() };
    return Promise.resolve(this.sourceValue);
  }
  createDraft(input: { orgId: string; source: TranslationSource; text: string; provenance: "manual" | "machine"; aiEventId: string | null; actorId: string }): Promise<TranslationDraft> {
    this.draftValue = { id: "11111111-1111-4111-8111-111111111122", orgId: input.orgId, sourceId: input.source.id, sourceHash: input.source.hash, sourceVersion: input.source.version, text: input.text, provenance: input.provenance, machineGenerated: input.provenance === "machine", aiEventId: input.aiEventId, status: "draft", createdBy: input.actorId, createdAt: new Date(0).toISOString(), reviewedBy: null, reviewerQualification: null, reviewerNote: null, reviewedAt: null, publishedBy: null, publishedAt: null, publishable: false };
    return Promise.resolve(this.draftValue);
  }
  approve(): Promise<null> { return Promise.resolve(null); }
  publish(): Promise<null> { return Promise.resolve(null); }
}

export async function runWp021Probe(repoRoot: string): Promise<Record<string, ProbeAssertion[]>> {
  const url = pathToFileURL(path.join(repoRoot, "packages", "i18n", "src", "index.ts")).href;
  const i18n = await tsImport(url, import.meta.url) as typeof I18nExports;
  const actor = { orgId: "11111111-1111-4111-8111-111111111111", userId: "11111111-1111-4111-8111-111111111101", roles: ["staff"] };
  const authorizer = i18n.createTranslationAuthorizer({ resolve: () => Promise.resolve({ qualification: "Synthetic qualified reviewer", grantedBy: actor.userId }) });
  const manualRepo = new Wp021Repository();
  const manual = new i18n.TranslationWorkflow(manualRepo, authorizer);
  const manualSource = await manual.updateSource(actor, { key: "office", text: "The office opens Monday.", critical: false });
  let machineUnavailable = false;
  try { await manual.draft(actor, { sourceId: manualSource.id, machine: true }); }
  catch (error) { machineUnavailable = error instanceof i18n.TranslationAiUnavailable; }
  const manualDraft = await manual.draft(actor, { sourceId: manualSource.id, text: "La oficina abre el lunes." });
  const machineRepo = new Wp021Repository();
  const gateway = { translate: (request: { sourceVersion: string }) => Promise.resolve({ outcome: "ok", text: "Llame al 911 ahora.", machineGenerated: true as const, sourceVersion: request.sourceVersion, eventId: "11111111-1111-4111-8111-111111111123" }) };
  const machine = new i18n.TranslationWorkflow(machineRepo, authorizer, gateway);
  const critical = await machine.updateSource(actor, { key: "danger", text: "Call 911 now.", critical: true });
  const criticalDraft = await machine.draft(actor, { sourceId: critical.id, machine: true });
  let publishRejected = false;
  try { await machine.publish(actor, { draftId: criticalDraft.id, sourceHash: criticalDraft.sourceHash, sourceVersion: criticalDraft.sourceVersion }); }
  catch (error) { publishRejected = error instanceof i18n.TranslationConflict; }
  const workflow = validateWp021WorkflowEvidence({ manualAvailable: manualDraft.provenance === "manual" && !manualDraft.machineGenerated && manualDraft.status === "draft", machineUnavailable, criticalHeld: criticalDraft.provenance === "machine" && criticalDraft.machineGenerated && criticalDraft.status === "draft" && !criticalDraft.publishable, publishRejected });
  const source = "Do not visit 125 Oak Street before September 18, 2026. Call 212-555-0198.";
  const good = "No visite 125 Oak Street antes del 18 de septiembre de 2026. Llame al 212-555-0198.";
  const fidelity = validateWp021FidelityEvidence({ goodFailures: fidelityFailures(source, good), changedPhone: fidelityFailures(source, good.replace("212-555-0198", "212-555-0199")), missingFullDate: fidelityFailures(source, good.replace("18 de septiembre de 2026", "18 de 2026")), changedAddress: fidelityFailures(source, good.replace("125 Oak Street", "125 Pine Street")), droppedNegation: fidelityFailures(source, good.replace("No visite", "Visite")) });
  return { "EV-wp021-workflow-01": workflow, "EV-wp021-fidelity-01": fidelity };
}

export async function runWp008Probe(repoRoot: string): Promise<Record<string, ProbeAssertion[]>> {
  const url = pathToFileURL(path.join(repoRoot, "packages", "ai", "src", "index.ts")).href;
  const ai = await tsImport(url, import.meta.url) as typeof AiExports;
  const context = { orgId: "11111111-1111-4111-8111-111111111111", userId: "22222222-2222-4222-8222-222222222222", userRole: "senior" as const, locale: "en" as const, requestId: "wp022-eval" };
  const makeGateway = (enabled: boolean, provider: InstanceType<typeof ai.StubProviderAdapter>, providerCalls: { value: number }, events: Array<{ costUsd: number }>) => {
    const counted = { ...provider, complete: (input: Parameters<typeof provider.complete>[0]) => { providerCalls.value += 1; return provider.complete(input); } };
    return new ai.DefaultAiGateway({
      flags: { effective: (key) => Promise.resolve(key === "ai.cache.exact_match" || enabled) },
      events: { append: (event) => { events.push(event); return Promise.resolve({ id: `event-${events.length}` }); } },
      prompts: { get: (feature) => Promise.resolve({ ref: { feature, version: "v1", hash: "wp022" }, text: "safe prompt" }) },
      router: { route: () => ({ provider: "stub", model: "test-stub", maxOutputTokens: 100 }) }, providers: new Map([["stub", counted]]),
      rateLimiter: new ai.FixedWindowRateLimiter(), reservations: new ai.InMemoryReservationStore(), cache: new ai.InMemoryExactCache(),
      cacheBoundary: { describe: () => Promise.resolve({ cacheable: true, sourceContentVersionSet: ["directory:1:v1"] }), reauthorize: () => Promise.resolve(true) },
      prices: new ai.StaticPriceBook({ "stub:test-stub": { inputPerMillionUsd: 0, outputPerMillionUsd: 0, cachedPerMillionUsd: 0 } }),
    });
  };
  const killedCalls = { value: 0 }; const killedEvents: Array<{ costUsd: number }> = [];
  const killed = await makeGateway(false, new ai.StubProviderAdapter(), killedCalls, killedEvents).chat({ feature: "concierge", context, messages: [{ role: "user", content: "help" }] });
  const cacheCalls = { value: 0 }; const cacheEvents: Array<{ costUsd: number }> = [];
  const cacheGateway = makeGateway(true, new ai.StubProviderAdapter(), cacheCalls, cacheEvents);
  const request = { feature: "concierge" as const, context, messages: [{ role: "user" as const, content: "Where is lunch?" }] };
  const first = await cacheGateway.chat(request); const second = await cacheGateway.chat(request);
  let transportCalls = 0; let blocked = false;
  const adapter = new ai.AnthropicProviderAdapter({ send: () => { transportCalls += 1; return Promise.resolve({}); } }, new ai.CanaryEgressGuard(["CANARY-DO-NOT-SEND"]), "claude-haiku-4-5");
  try { await adapter.complete({ system: "safe", messages: [{ role: "user", content: "CANARY-DO-NOT-SEND" }], signal: new AbortController().signal }); }
  catch (error) { blocked = error instanceof ai.EgressBlockedError; }
  return validateWp008Evidence({ killed: { outcome: killed.outcome, humanRoute: killed.humanRoute, providerCalls: killedCalls.value, events: killedEvents.length }, cache: { firstCacheHit: first.cacheHit, secondCacheHit: second.cacheHit, providerCalls: cacheCalls.value, events: cacheEvents.length, costs: cacheEvents.map((event) => event.costUsd) }, egress: { blocked, transportCalls } });
}

export async function runWp023Probe(repoRoot: string): Promise<ProbeAssertion[]> {
  const url = pathToFileURL(path.join(repoRoot, "packages", "rag", "src", "index.ts")).href;
  const rag = await tsImport(url, import.meta.url) as typeof RagExports;
  const exact = "11111111-1111-4111-8111-111111111151"; const semantic = "11111111-1111-4111-8111-111111111152";
  const service = rag.createRagService({ flags: { effective: () => Promise.resolve(true) }, repository: { prepare: () => Promise.resolve(null), replace: () => Promise.resolve("missing"), hybrid: () => Promise.resolve([{ service_id: exact, score: 1 }, { service_id: semantic, score: 0.49 }]) }, gateway: { embed: () => Promise.resolve({ outcome: "ok", vectors: [[0.2, 0.8]], dimensions: 2, model: "test-stub" }) }, fts: { search: () => Promise.resolve({ items: [{ id: exact }] }) }, jobs: { resolveService: () => Promise.resolve(null) } });
  const response = await service.search({ orgId: "11111111-1111-4111-8111-111111111111", userId: "11111111-1111-4111-8111-111111111101", requestId: "11111111-1111-4111-8111-111111111191", userRole: "senior", locale: "en", query: "meal delivery", limit: 2 });
  return validateWp023Evidence({ ids: response.items.map((item) => item.service_id), keys: response.items.map((item) => Object.keys(item).sort()) }, exact, semantic);
}
