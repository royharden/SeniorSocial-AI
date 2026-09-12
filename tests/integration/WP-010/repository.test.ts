import { describe, expect, it } from 'vitest';
import { createServicesRepository, ServiceValidationError } from '../../../packages/services/src/index.ts';

describe('services repository SQL contract', () => {
  // what_bug_this_catches: equal-rank results reorder nondeterministically between requests or locales use the wrong text-search configuration.
  it('uses locale-specific FTS with name and id as stable tie-breakers', async () => {
    let statement = '';
    const repository = createServicesRepository(async (_orgId, work) => work({
      query: async <T>(text: string) => { statement = text; return [] as T[]; },
      audit: async () => undefined,
    }));
    await repository.search('11111111-1111-4111-8111-111111111111', { query: 'comida cerca', locale: 'es' });
    expect(statement).toContain("'spanish'::regconfig");
    expect(statement).toContain("case when $3='es' then s.name_es else s.name_en end asc, s.id asc");
    expect(statement).toContain("s.publication_state = 'published'");
    expect(statement).toContain('limit $8');
  });

  // what_bug_this_catches: numeric-looking cursors become Infinity or an unbounded database OFFSET.
  it.each(['Infinity', '1e309', '9007199254740992', '10001'])('rejects unsafe cursor %s', async cursor => {
    const repository = createServicesRepository(async (_orgId, work) => work({
      query: async <T>() => [] as T[], audit: async () => undefined,
    }));
    await expect(repository.search('11111111-1111-4111-8111-111111111111', { locale: 'en', cursor }))
      .rejects.toBeInstanceOf(ServiceValidationError);
  });

  // what_bug_this_catches: a partial PATCH clears omitted tags/scalars or cannot identify the exact edited field.
  it('locks the row and preserves omitted values on a phone-only patch', async () => {
    const statements: { text: string; values: readonly (string | number | null)[] }[] = [];
    const before = {
      id: '11111111-1111-4111-8111-111111111151', org_id: '11111111-1111-4111-8111-111111111111',
      external_id: 'meal-1', category_id: '11111111-1111-4111-8111-111111111141', name_en: 'Meals', name_es: 'Comidas',
      description_en: 'Delivered', description_es: 'Entrega', eligibility_note_en: '', eligibility_note_es: '', phone: '',
      source_updated_at: '2026-09-10T12:00:00Z', languages: ['en', 'es'], accessibility: ['wheelchair'], publication_state: 'published',
    };
    const repository = createServicesRepository(async (_orgId, work) => work({
      query: async <T>(text: string, values: readonly (string | number | null)[]) => {
        statements.push({ text, values });
        if (text.includes('for update of s')) return [before] as T[];
        if (text.includes('($3 = 0')) return [{ ...before, phone: '555-0110' }] as T[];
        return [] as T[];
      },
      audit: async intent => { expect(intent.fields).toEqual(['phone']); },
    }));
    const result = await repository.update(before.org_id, '11111111-1111-4111-8111-111111111101', before.id,
      { phone: '555-0110' }, 'en');
    expect(result).toMatchObject({ changedFields: ['phone'], didWrite: true, service: { phone: '555-0110' } });
    expect(statements[0]?.text).toContain('for update of s');
    const update = statements.find(call => call.text.startsWith('update services set'));
    expect(update?.values.slice(2, 10)).toEqual([null, null, null, null, null, null, null, null]);
    expect(statements.some(call => call.text.includes('delete from service_'))).toBe(false);
  });

  // what_bug_this_catches: a repository resolves its transaction before attempting the required audit append.
  it('audits inside create transaction and propagates audit failure', async () => {
    const calls: string[] = [];
    const repository = createServicesRepository(async (_orgId, work) => work({
      query: async <T>(text: string) => {
        calls.push(text.startsWith('insert into services') ? 'write' : 'query');
        if (text.startsWith('insert into services')) return [{ id: '11111111-1111-4111-8111-111111111151' }] as T[];
        return [] as T[];
      },
      audit: async () => { calls.push('audit'); throw new Error('audit insert failed'); },
    }));
    await expect(repository.create('11111111-1111-4111-8111-111111111111',
      '11111111-1111-4111-8111-111111111101', {
        categoryId: '11111111-1111-4111-8111-111111111141', nameEn: 'Meals', nameEs: 'Comidas',
        sourceUpdatedAt: '2026-09-10T12:00:00Z',
      }, 'en')).rejects.toThrow('audit insert failed');
    expect(calls).toContain('write');
    expect(calls.at(-1)).toBe('audit');
  });

  // what_bug_this_catches: direct-create audit fields omit columns explicitly written by the repository.
  it('reports every canonical field written by direct create', async () => {
    let fields: string[] = [];
    const repository = createServicesRepository(async (_orgId, work) => work({
      query: async <T>(text: string) => text.startsWith('insert into services')
        ? [{ id: '11111111-1111-4111-8111-111111111151' }] as T[] : [] as T[],
      audit: async intent => { fields = intent.fields; },
    }));
    await repository.create('11111111-1111-4111-8111-111111111111',
      '11111111-1111-4111-8111-111111111101', {
        externalId: 'meal-1', categoryId: '11111111-1111-4111-8111-111111111141',
        nameEn: 'Meals', nameEs: 'Comidas', sourceUpdatedAt: '2026-09-10T12:00:00Z',
      }, 'en');
    expect(fields).toEqual([
      'accessibility', 'category_id', 'description_en', 'description_es', 'eligibility_note_en',
      'eligibility_note_es', 'external_id', 'languages', 'name_en', 'name_es', 'phone',
      'publication_state', 'reviewed_at', 'reviewed_by', 'source_updated_at',
    ]);
  });

  // what_bug_this_catches: approval-only PATCH emits an empty field list even though it changes review state.
  it('reports exactly the publication metadata changed by empty draft approval', async () => {
    const auditFields: string[][] = [];
    const draft = {
      id: '11111111-1111-4111-8111-111111111151', org_id: '11111111-1111-4111-8111-111111111111',
      external_id: 'meal-1', category_id: '11111111-1111-4111-8111-111111111141', name_en: 'Meals', name_es: 'Comidas',
      description_en: '', description_es: '', eligibility_note_en: '', eligibility_note_es: '', phone: '',
      source_updated_at: '2026-09-10T12:00:00Z', languages: [], accessibility: [], publication_state: 'draft',
      reviewed_by: null, reviewed_at: null,
    };
    const repository = createServicesRepository(async (_orgId, work) => work({
      query: async <T>(text: string) => {
        if (text.includes('for update of s')) return [draft] as T[];
        if (text.includes('($3 = 0')) return [{ ...draft, publication_state: 'published' }] as T[];
        return [] as T[];
      },
      audit: async intent => { auditFields.push(intent.fields); },
    }));
    await repository.update(draft.org_id, '11111111-1111-4111-8111-111111111101', draft.id, {}, 'en');
    expect(auditFields).toEqual([['publication_state', 'reviewed_at', 'reviewed_by']]);
  });

  // what_bug_this_catches: CSV re-import claims every service field changed instead of the true content and review transition.
  it('reports exact CSV update content and draft-transition fields', async () => {
    const auditFields: string[][] = [];
    const published = {
      id: '11111111-1111-4111-8111-111111111151', org_id: '11111111-1111-4111-8111-111111111111',
      external_id: 'meal-1', category_id: '11111111-1111-4111-8111-111111111141', name_en: 'Meals', name_es: 'Comidas',
      description_en: '', description_es: '', eligibility_note_en: '', eligibility_note_es: '', phone: '',
      source_updated_at: '2026-09-10T12:00:00Z', languages: [], accessibility: [], publication_state: 'published',
      reviewed_by: '11111111-1111-4111-8111-111111111101', reviewed_at: '2026-09-10T12:01:00Z',
    };
    const repository = createServicesRepository(async (_orgId, work) => work({
      query: async <T>(text: string) => {
        if (text.startsWith('insert into service_imports')) return [{ id: '11111111-1111-4111-8111-111111111190' }] as T[];
        if (text.startsWith('select exists')) return [{ exists: true }] as T[];
        if (text.includes('s.external_id=$2')) return [published] as T[];
        if (text.startsWith('update services set')) return [{ id: published.id }] as T[];
        return [] as T[];
      },
      audit: async intent => { auditFields.push(intent.fields); },
    }));
    await repository.importRows(published.org_id, published.reviewed_by, [{ row: 2, input: {
      externalId: published.external_id, categoryId: published.category_id, nameEn: 'Meals updated',
      nameEs: published.name_es, phone: '555-0110', sourceUpdatedAt: '2026-09-10T12:00:00Z',
    } }]);
    expect(auditFields).toEqual([['name_en', 'phone', 'publication_state', 'reviewed_at', 'reviewed_by']]);
  });
});
