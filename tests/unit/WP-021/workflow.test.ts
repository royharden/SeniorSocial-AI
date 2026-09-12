import { randomUUID } from 'node:crypto';
/* eslint-disable @typescript-eslint/require-await -- async repository doubles intentionally implement the production port */
import { describe, expect, it, vi } from 'vitest';
import {
  TranslationAiUnavailable, TranslationConflict, TranslationDenied, TranslationWorkflow,
  createTranslationAuthorizer, sourceHash,
  type Actor, type TranslationDraft, type TranslationRepository, type TranslationSource,
} from '../../../packages/i18n/src/index';

class MemoryRepository implements TranslationRepository {
  sources = new Map<string, TranslationSource>(); drafts = new Map<string, TranslationDraft>();
  async list(orgId: string) { return [...this.sources.values()].filter(source => source.orgId === orgId).map(source => ({ source, history: [...this.drafts.values()].filter(draft => draft.orgId === orgId && draft.sourceId === source.id) })); }
  async source(orgId: string, sourceId: string) { const value = this.sources.get(sourceId); return value?.orgId === orgId ? value : null; }
  async draft(orgId: string, draftId: string) { const value = this.drafts.get(draftId); return value?.orgId === orgId ? value : null; }
  async upsertSource(input: { orgId: string; key: string; text: string; hash: string; critical: boolean; actorId: string }) {
    const previous = [...this.sources.values()].find(item => item.orgId === input.orgId && item.key === input.key);
    const changed = previous && (previous.hash !== input.hash || previous.critical !== input.critical);
    if (changed) for (const [id, item] of this.drafts) if (item.sourceId === previous.id && item.status !== 'invalidated') this.drafts.set(id, { ...item, status: 'invalidated', publishable: false });
    const value: TranslationSource = { id: previous?.id ?? randomUUID(), orgId: input.orgId, key: input.key, text: input.text, hash: input.hash, version: previous ? previous.version + (changed ? 1 : 0) : 1, critical: input.critical, updatedAt: new Date().toISOString() };
    this.sources.set(value.id, value); return value;
  }
  async createDraft(input: { orgId: string; source: TranslationSource; text: string; provenance: 'manual' | 'machine'; aiEventId: string | null; actorId: string }) {
    const current = this.sources.get(input.source.id); if (current?.hash !== input.source.hash || current.version !== input.source.version) throw new TranslationConflict();
    const value: TranslationDraft = { id: randomUUID(), orgId: input.orgId, sourceId: input.source.id, sourceHash: input.source.hash, sourceVersion: input.source.version, text: input.text, provenance: input.provenance, machineGenerated: input.provenance === 'machine', aiEventId: input.aiEventId, status: 'draft', createdBy: input.actorId, createdAt: new Date().toISOString(), reviewedBy: null, reviewerQualification: null, reviewerNote: null, reviewedAt: null, publishedBy: null, publishedAt: null, publishable: false };
    this.drafts.set(value.id, value); return value;
  }
  async approve(input: { orgId: string; draftId: string; sourceHash: string; sourceVersion: number; actorId: string; qualification: string; note: string }) {
    const item = this.drafts.get(input.draftId); const current = item && this.sources.get(item.sourceId);
    if (!item || item.orgId !== input.orgId || item.status !== 'draft' || current?.hash !== input.sourceHash || current.version !== input.sourceVersion || item.sourceHash !== input.sourceHash) return null;
    const result = { ...item, status: 'approved' as const, reviewedBy: input.actorId, reviewerQualification: input.qualification, reviewerNote: input.note, reviewedAt: new Date().toISOString(), publishable: true }; this.drafts.set(item.id, result); return result;
  }
  async publish(input: { orgId: string; draftId: string; sourceHash: string; sourceVersion: number; actorId: string; qualification: string }) {
    const item = this.drafts.get(input.draftId); const current = item && this.sources.get(item.sourceId);
    if (!item || item.orgId !== input.orgId || item.status !== 'approved' || !item.publishable || current?.hash !== input.sourceHash || current.version !== input.sourceVersion) return null;
    const result = { ...item, publishedBy: input.actorId, publishedAt: new Date().toISOString(), publishable: false }; this.drafts.set(item.id, result); return result;
  }
}

const staff: Actor = { orgId: randomUUID(), userId: randomUUID(), roles: ['staff'] };
const registry = { resolve: vi.fn(async (orgId: string, userId: string) => orgId === staff.orgId && userId === staff.userId ? { qualification: 'Qualified municipal Spanish reviewer', grantedBy: randomUUID() } : null) };

describe('WP-021 translation workflow', () => {
  it('keeps the manual workflow usable with AI off and records qualified review evidence', async () => {
    // what_bug_this_catches: an AI feature flag accidentally making human translation work impossible.
    const repository = new MemoryRepository(); const workflow = new TranslationWorkflow(repository, createTranslationAuthorizer(registry));
    const source = await workflow.updateSource(staff, { key: 'notice.body', text: 'Call the office.', critical: true });
    const draft = await workflow.draft(staff, { sourceId: source.id, text: 'Llame a la oficina.' });
    expect(draft).toMatchObject({ machineGenerated: false, provenance: 'manual', status: 'draft' });
    const approved = await workflow.approve(staff, { draftId: draft.id, sourceHash: source.hash, sourceVersion: source.version, note: 'Revisado en contexto.' });
    expect(approved).toMatchObject({ status: 'approved', reviewerQualification: 'Qualified municipal Spanish reviewer', publishable: true });
    expect(await workflow.publish(staff, { draftId: draft.id, sourceHash: source.hash, sourceVersion: source.version })).toMatchObject({ publishedBy: staff.userId });
  });

  it('uses only the injected WP-008-shaped translate gateway and preserves machine provenance', async () => {
    // what_bug_this_catches: translation code bypassing the gateway or losing the event/source link.
    const repository = new MemoryRepository(); const translate = vi.fn(async (request: { sourceVersion: string }) => ({ outcome: 'ok', text: 'Texto asistido', machineGenerated: true as const, sourceVersion: request.sourceVersion, eventId: randomUUID() }));
    const workflow = new TranslationWorkflow(repository, createTranslationAuthorizer(registry), { translate });
    const source = await workflow.updateSource(staff, { key: 'x', text: 'Source', critical: true }); const draft = await workflow.draft(staff, { sourceId: source.id, machine: true, requestId: 'request-1' });
    expect(translate).toHaveBeenCalledWith(expect.objectContaining({ feature: 'translation_assist', critical: true, from: 'en', to: 'es' }));
    expect(draft).toMatchObject({ provenance: 'machine', machineGenerated: true, status: 'draft' });
    await expect(workflow.publish(staff, { draftId: draft.id, sourceHash: source.hash, sourceVersion: source.version })).rejects.toBeInstanceOf(TranslationConflict);
  });

  it.each([
    { text: 'x'.repeat(20_001), eventId: randomUUID() },
    { text: 'Texto válido', eventId: 'not-an-ai-event-id' },
  ])('rejects unsafe gateway evidence before persisting a machine draft', async gatewayResult => {
    // what_bug_this_catches: oversized provider output or an uncastable event ID reaching translation storage.
    const repository = new MemoryRepository(); const createDraft = vi.spyOn(repository, 'createDraft');
    const workflow = new TranslationWorkflow(repository, createTranslationAuthorizer(registry), { translate: async request => ({ outcome:'ok',machineGenerated:true as const,sourceVersion:request.sourceVersion,...gatewayResult }) });
    const source = await workflow.updateSource(staff,{key:'gateway-guard',text:'Source',critical:false});
    await expect(workflow.draft(staff,{sourceId:source.id,machine:true})).rejects.toBeInstanceOf(TranslationAiUnavailable);
    expect(createDraft).not.toHaveBeenCalled();
  });

  it('fails closed for AI-off, unqualified review, cross-org IDs, and a source edit race', async () => {
    // what_bug_this_catches: stale or cross-tenant critical machine copy becoming publishable.
    const repository = new MemoryRepository(); const workflow = new TranslationWorkflow(repository, createTranslationAuthorizer({ resolve: async () => null }));
    const source = await workflow.updateSource(staff, { key: 'critical', text: 'Old', critical: true });
    await expect(workflow.draft(staff, { sourceId: source.id, machine: true })).rejects.toBeInstanceOf(TranslationAiUnavailable);
    const draft = await workflow.draft(staff, { sourceId: source.id, text: 'Anterior' });
    await workflow.updateSource(staff, { key: 'critical', text: 'New', critical: true });
    await expect(workflow.approve(staff, { draftId: draft.id, sourceHash: source.hash, sourceVersion: source.version, note: 'ok' })).rejects.toBeInstanceOf(TranslationDenied);
    await expect(workflow.draft({ ...staff, orgId: randomUUID() }, { sourceId: source.id, text: 'No' })).rejects.toBeInstanceOf(TranslationDenied);
    expect(repository.drafts.get(draft.id)?.status).toBe('invalidated');
    expect(sourceHash('New')).not.toBe(source.hash);
  });

  it('allows only one of concurrent/replayed approval attempts', async () => {
    // what_bug_this_catches: two reviewers replaying the same stale approval transition successfully.
    const repository = new MemoryRepository(); const workflow = new TranslationWorkflow(repository, createTranslationAuthorizer(registry));
    const source = await workflow.updateSource(staff, { key: 'race', text: 'Race source', critical: true });
    const draft = await workflow.draft(staff, { sourceId: source.id, text: 'Texto' });
    const attempts = await Promise.allSettled([1, 2].map(index => workflow.approve(staff, { draftId: draft.id, sourceHash: source.hash, sourceVersion: source.version, note: `Review ${index}` })));
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter(result => result.status === 'rejected' && result.reason instanceof TranslationConflict)).toHaveLength(1);
  });
});
