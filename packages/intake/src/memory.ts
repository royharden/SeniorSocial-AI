import type { IntakeInput, IntakeKind, IntakeRepository, IntakeRoute, IntakeSubmission, SaveResult } from './types.ts';

export class MemoryIntakeRepository implements IntakeRepository {
  readonly submissions: IntakeSubmission[] = [];
  private readonly creates = new Map<string, { hash: string; id: string }>();
  private readonly updates = new Map<string, { hash: string; id: string }>();
  private readonly categories = new Map<string, { id: string; slug: string; labelEn: string; labelEs: string }>();

  constructor(categories = [
    { id: '10000000-0000-4000-8000-000000000001', slug: 'legal-services', labelEn: 'Legal services', labelEs: 'Servicios legales' },
    { id: '10000000-0000-4000-8000-000000000002', slug: 'health-navigation', labelEn: 'Health navigation', labelEs: 'Orientación de salud' },
    { id: '10000000-0000-4000-8000-000000000003', slug: 'housing', labelEn: 'Housing', labelEs: 'Vivienda' },
    { id: '10000000-0000-4000-8000-000000000004', slug: 'benefits', labelEn: 'Benefits', labelEs: 'Beneficios' },
    { id: '10000000-0000-4000-8000-000000000005', slug: 'behavioral-health', labelEn: 'Behavioral health navigation', labelEs: 'Orientación de salud conductual' },
    { id: '10000000-0000-4000-8000-000000000006', slug: 'transportation', labelEn: 'Transportation', labelEs: 'Transporte' },
  ]) { for (const item of categories) this.categories.set(item.slug, item); }

  save(orgId: string, residentId: string, kind: IntakeKind, input: IntakeInput, route: IntakeRoute | null,
    idempotencyKey: string, requestHash: string, at: string, id?: string): Promise<SaveResult | null> {
    const replayKey = id ? `${orgId}:${residentId}:${id}:${idempotencyKey}` : `${orgId}:${residentId}:${idempotencyKey}`;
    const store = id ? this.updates : this.creates; const replay = store.get(replayKey);
    if (replay) {
      if (replay.hash !== requestHash) throw Object.assign(new Error('Idempotency conflict'), { status: 409 });
      return Promise.resolve({ submission: structuredClone(this.submissions.find(item => item.id === replay.id)!), created: false });
    }
    let submission = id
      ? this.submissions.find(candidate => candidate.orgId === orgId && candidate.residentId === residentId && candidate.id === id)
      : undefined;
    if (id && (!submission || submission.state !== 'draft' || submission.kind !== kind)) return Promise.resolve(null);
    const created = !submission;
    if (!submission) {
      submission = { id: crypto.randomUUID(), orgId, residentId, kind, ...structuredClone(input),
        state: 'draft', routedCategory: null, createdAt: at, updatedAt: at };
      this.submissions.push(submission);
    } else {
      submission.answers = structuredClone(input.answers); submission.locale = input.locale;
      submission.disclaimerAcknowledged = input.disclaimerAcknowledged; submission.intent = input.intent; submission.updatedAt = at;
    }
    if (route) {
      const category = this.categories.get(route.slug); if (!category) throw Object.assign(new Error('Partner category is unavailable'), { status: 422 });
      submission.state = 'routed'; submission.routedCategory = category; submission.updatedAt = at;
    }
    store.set(replayKey, { hash: requestHash, id: submission.id });
    return Promise.resolve({ submission: structuredClone(submission), created });
  }

  get(orgId: string, residentId: string, id: string): Promise<IntakeSubmission | null> {
    const item = this.submissions.find(candidate => candidate.orgId === orgId && candidate.residentId === residentId && candidate.id === id);
    return Promise.resolve(item ? structuredClone(item) : null);
  }

}
