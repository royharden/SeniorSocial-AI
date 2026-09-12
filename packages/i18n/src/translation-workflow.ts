import { createHash, randomUUID } from 'node:crypto';

export type TranslationStatus = 'draft' | 'awaiting_review' | 'approved' | 'invalidated';
export type TranslationProvenance = 'manual' | 'machine';
export type StaffRole = 'staff' | 'admin';
export interface Actor { readonly orgId: string; readonly userId: string; readonly roles: readonly string[] }
export interface QualifiedReviewCapability { readonly qualification: string; readonly grantedBy: string }
export interface QualifiedReviewerRegistry { resolve(orgId: string, userId: string): Promise<QualifiedReviewCapability | null> }
export interface TranslationAuthorizer { staff(actor: Actor): boolean; qualified(actor: Actor): Promise<QualifiedReviewCapability | null> }

export function createTranslationAuthorizer(registry: QualifiedReviewerRegistry): TranslationAuthorizer {
  return {
    staff: actor => actor.roles.some(role => role === 'staff' || role === 'admin'),
    qualified: async actor => actor.roles.some(role => role === 'staff' || role === 'admin') ? registry.resolve(actor.orgId, actor.userId) : null,
  };
}

export interface TranslationSource { readonly id: string; readonly orgId: string; readonly key: string; readonly text: string; readonly hash: string; readonly version: number; readonly critical: boolean; readonly updatedAt: string }
export interface TranslationDraft {
  readonly id: string; readonly orgId: string; readonly sourceId: string; readonly sourceHash: string; readonly sourceVersion: number;
  readonly text: string; readonly provenance: TranslationProvenance; readonly machineGenerated: boolean; readonly aiEventId: string | null;
  readonly status: TranslationStatus; readonly createdBy: string; readonly createdAt: string; readonly reviewedBy: string | null;
  readonly reviewerQualification: string | null; readonly reviewerNote: string | null; readonly reviewedAt: string | null;
  readonly publishedBy: string | null; readonly publishedAt: string | null; readonly publishable: boolean;
}
export interface TranslationView { readonly source: TranslationSource; readonly history: readonly TranslationDraft[] }
export interface TranslationRepository {
  list(orgId: string): Promise<readonly TranslationView[]>;
  source(orgId: string, sourceId: string): Promise<TranslationSource | null>;
  draft(orgId: string, draftId: string): Promise<TranslationDraft | null>;
  upsertSource(input: { orgId: string; key: string; text: string; hash: string; critical: boolean; actorId: string }): Promise<TranslationSource>;
  createDraft(input: { orgId: string; source: TranslationSource; text: string; provenance: TranslationProvenance; aiEventId: string | null; actorId: string }): Promise<TranslationDraft>;
  approve(input: { orgId: string; draftId: string; sourceHash: string; sourceVersion: number; actorId: string; qualification: string; note: string }): Promise<TranslationDraft | null>;
  publish(input: { orgId: string; draftId: string; sourceHash: string; sourceVersion: number; actorId: string; qualification: string }): Promise<TranslationDraft | null>;
}
export interface TranslationGateway {
  translate(request: { feature: 'translation_assist'; context: { orgId: string; userId: string; userRole: StaffRole; locale: 'es'; requestId: string }; text: string; from: 'en'; to: 'es'; sourceVersion: string; critical: boolean }):
    Promise<{ outcome: string; text: string; machineGenerated: true; sourceVersion: string; eventId: string }>;
}

export class TranslationDenied extends Error { readonly code = 'not_found'; }
export class TranslationConflict extends Error { readonly code = 'stale_translation'; }
export class TranslationInvalid extends Error { readonly code = 'invalid_request'; }
export class TranslationAiUnavailable extends Error { readonly code = 'translation_assist_unavailable'; }
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const hashPattern = /^[0-9a-f]{64}$/u;
function required(value: string, field: string, max: number): string { const normalized = value.trim(); if (!normalized || value.length > max) throw new TranslationInvalid(`${field} is invalid`); return normalized; }
function identifier(value: string): string { if (!uuidPattern.test(value)) throw new TranslationInvalid('identifier is invalid'); return value; }
function expectedVersion(hash: string, version: number): void { if (!hashPattern.test(hash) || !Number.isSafeInteger(version) || version <= 0) throw new TranslationInvalid('source version is invalid'); }
export function sourceHash(text: string): string { return createHash('sha256').update(text, 'utf8').digest('hex'); }

export class TranslationWorkflow {
  constructor(private readonly repository: TranslationRepository, private readonly authorizer: TranslationAuthorizer, private readonly gateway?: TranslationGateway) {}
  async list(actor: Actor): Promise<readonly TranslationView[]> { this.requireStaff(actor); return this.repository.list(actor.orgId); }
  async updateSource(actor: Actor, input: { key: string; text: string; critical: boolean }): Promise<TranslationSource> {
    this.requireStaff(actor); const text = required(input.text, 'text', 20_000);
    return this.repository.upsertSource({ orgId: actor.orgId, key: required(input.key, 'key', 200), text, hash: sourceHash(text), critical: input.critical, actorId: actor.userId });
  }
  async draft(actor: Actor, input: { sourceId: string; text?: string; machine?: boolean; requestId?: string }): Promise<TranslationDraft> {
    this.requireStaff(actor); const source = await this.repository.source(actor.orgId, identifier(input.sourceId)); if (!source) throw new TranslationDenied();
    if (!input.machine) return this.repository.createDraft({ orgId: actor.orgId, source, text: required(input.text ?? '', 'text', 20_000), provenance: 'manual', aiEventId: null, actorId: actor.userId });
    if (!this.gateway) throw new TranslationAiUnavailable('AI is off; enter a manual Spanish draft');
    const role: StaffRole = actor.roles.includes('admin') ? 'admin' : 'staff'; const sourceVersion = `${source.version}:${source.hash}`;
    const requestId = input.requestId === undefined ? randomUUID() : required(input.requestId, 'requestId', 200);
    const result = await this.gateway.translate({ feature: 'translation_assist', context: { orgId: actor.orgId, userId: actor.userId, userRole: role, locale: 'es', requestId }, text: source.text, from: 'en', to: 'es', sourceVersion, critical: source.critical });
    if (result.outcome !== 'ok' || result.sourceVersion !== sourceVersion) throw new TranslationAiUnavailable('Machine draft was not safely produced');
    let translatedText: string; let aiEventId: string;
    try { translatedText = required(result.text, 'text', 20_000); aiEventId = identifier(result.eventId); }
    catch { throw new TranslationAiUnavailable('Machine draft was not safely produced'); }
    const current = await this.repository.source(actor.orgId, source.id);
    if (!current || current.hash !== source.hash || current.version !== source.version) throw new TranslationConflict('Source changed while drafting');
    return this.repository.createDraft({ orgId: actor.orgId, source, text: translatedText, provenance: 'machine', aiEventId, actorId: actor.userId });
  }
  async approve(actor: Actor, input: { draftId: string; sourceHash: string; sourceVersion: number; note: string }): Promise<TranslationDraft> {
    this.requireStaff(actor); identifier(input.draftId); expectedVersion(input.sourceHash, input.sourceVersion); const capability = await this.authorizer.qualified(actor); if (!capability) throw new TranslationDenied();
    const result = await this.repository.approve({ orgId: actor.orgId, draftId: input.draftId, sourceHash: input.sourceHash, sourceVersion: input.sourceVersion, actorId: actor.userId, qualification: capability.qualification, note: required(input.note, 'note', 500) });
    if (!result) throw new TranslationConflict('Draft is stale, absent, or already reviewed'); return result;
  }
  async approveCanonical(actor: Actor, input: { draftId: string; sourceVersion: string; note: string }): Promise<TranslationDraft> {
    this.requireStaff(actor); identifier(input.draftId);
    const draft = await this.repository.draft(actor.orgId, input.draftId); if (!draft) throw new TranslationDenied();
    if (`${draft.sourceVersion}:${draft.sourceHash}` !== input.sourceVersion) throw new TranslationConflict('Draft source version is stale');
    return this.approve(actor, { draftId: draft.id, sourceHash: draft.sourceHash, sourceVersion: draft.sourceVersion, note: input.note });
  }
  async publish(actor: Actor, input: { draftId: string; sourceHash: string; sourceVersion: number }): Promise<TranslationDraft> {
    this.requireStaff(actor); identifier(input.draftId); expectedVersion(input.sourceHash, input.sourceVersion); const capability = await this.authorizer.qualified(actor); if (!capability) throw new TranslationDenied();
    const result = await this.repository.publish({ orgId: actor.orgId, draftId: input.draftId, sourceHash: input.sourceHash, sourceVersion: input.sourceVersion, actorId: actor.userId, qualification: capability.qualification });
    if (!result) throw new TranslationConflict('Draft is stale, unapproved, absent, or already published'); return result;
  }
  private requireStaff(actor: Actor): void { if (!uuidPattern.test(actor.orgId) || !uuidPattern.test(actor.userId) || !this.authorizer.staff(actor)) throw new TranslationDenied(); }
}
