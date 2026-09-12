import { ServiceValidationError } from './errors.ts';
import type {
  CreateServiceInput, OrgTransaction, PatchServiceInput, Service, ServiceCategory, ServiceLocale, ServiceSearch,
} from './types.ts';

type Sql = Parameters<Parameters<OrgTransaction>[1]>[0];
interface ServiceRow {
  id: string; org_id: string; external_id: string | null; category_id: string; name_en: string; name_es: string;
  description_en: string; description_es: string; eligibility_note_en: string; eligibility_note_es: string;
  phone: string; source_updated_at: string | Date; languages: string[]; accessibility: string[];
  publication_state: 'draft' | 'published'; reviewed_by: string | null; reviewed_at: string | Date | null;
}
const maxSearchOffset = 10_000;
const createFields = ['external_id', 'category_id', 'name_en', 'name_es', 'description_en', 'description_es',
  'eligibility_note_en', 'eligibility_note_es', 'phone', 'languages', 'accessibility', 'source_updated_at',
  'publication_state', 'reviewed_by', 'reviewed_at'];
const projection = `s.id, s.org_id, s.external_id, s.category_id, s.name_en, s.name_es, s.description_en, s.description_es,
  s.eligibility_note_en, s.eligibility_note_es, s.phone, s.source_updated_at, s.publication_state,
  s.reviewed_by, s.reviewed_at,
  coalesce((select array_agg(sl.language_code order by sl.language_code) from service_languages sl
    where sl.org_id = s.org_id and sl.service_id = s.id), array[]::text[]) as languages,
  coalesce((select array_agg(sa.accessibility_code order by sa.accessibility_code) from service_accessibility sa
    where sa.org_id = s.org_id and sa.service_id = s.id), array[]::text[]) as accessibility`;

function uniqueSorted(values: readonly string[] | undefined): string[] {
  return [...new Set(values ?? [])].sort();
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function completeChanges(before: ServiceRow, input: CreateServiceInput): string[] {
  const changed: string[] = [];
  const compare = (difference: boolean, field: string) => { if (difference) changed.push(field); };
  compare((input.externalId ?? null) !== before.external_id, 'external_id');
  compare(input.categoryId !== before.category_id, 'category_id');
  compare(input.nameEn.trim() !== before.name_en, 'name_en');
  compare(input.nameEs.trim() !== before.name_es, 'name_es');
  compare((input.descriptionEn?.trim() ?? '') !== before.description_en, 'description_en');
  compare((input.descriptionEs?.trim() ?? '') !== before.description_es, 'description_es');
  compare((input.eligibilityNoteEn?.trim() ?? '') !== before.eligibility_note_en, 'eligibility_note_en');
  compare((input.eligibilityNoteEs?.trim() ?? '') !== before.eligibility_note_es, 'eligibility_note_es');
  compare((input.phone?.trim() ?? '') !== before.phone, 'phone');
  compare(new Date(input.sourceUpdatedAt).toISOString() !== new Date(before.source_updated_at).toISOString(), 'source_updated_at');
  compare(!sameStrings(uniqueSorted(input.languages), uniqueSorted(before.languages)), 'languages');
  compare(!sameStrings(uniqueSorted(input.accessibility), uniqueSorted(before.accessibility)), 'accessibility');
  return changed;
}

function present(row: ServiceRow, locale: ServiceLocale): Service {
  const localized = locale === 'es';
  return {
    id: row.id, org_id: row.org_id, category_id: row.category_id,
    name: localized ? row.name_es : row.name_en,
    description: localized ? row.description_es : row.description_en,
    eligibility_note: localized ? row.eligibility_note_es : row.eligibility_note_en,
    phone: row.phone, languages: row.languages, accessibility: row.accessibility,
    source_updated_at: new Date(row.source_updated_at).toISOString(),
  };
}

export function createServicesRepository(withOrg: OrgTransaction) {
  async function auditUpdate(
    sql: Sql, orgId: string, actorId: string, id: string, fields: readonly string[], reason: string,
  ): Promise<void> {
    await sql.audit({ actor: `user:${actorId}`, on_behalf_of: null, action: 'service.updated', target: `service:${id}`,
      org_id: orgId, outcome: 'allowed', reason, fields: [...fields].sort() });
  }
  async function replaceLanguages(sql: Sql, orgId: string, id: string, languages: readonly string[]): Promise<void> {
    await sql.query('delete from service_languages where org_id = $1 and service_id = $2', [orgId, id]);
    for (const language of uniqueSorted(languages)) await sql.query(
      'insert into service_languages (org_id, service_id, language_code) values ($1, $2, $3)', [orgId, id, language]);
  }
  async function replaceAccessibility(sql: Sql, orgId: string, id: string, accessibility: readonly string[]): Promise<void> {
    await sql.query('delete from service_accessibility where org_id = $1 and service_id = $2', [orgId, id]);
    for (const item of uniqueSorted(accessibility)) await sql.query(
      'insert into service_accessibility (org_id, service_id, accessibility_code) values ($1, $2, $3)', [orgId, id, item]);
  }
  async function load(sql: Sql, orgId: string, id: string, locale: ServiceLocale, publishedOnly: boolean): Promise<Service | null> {
    const rows = await sql.query<ServiceRow>(`select ${projection} from services s
      where s.org_id = $1 and s.id = $2 and ($3 = 0 or s.publication_state = 'published') limit 1`,
    [orgId, id, publishedOnly ? 1 : 0]);
    return rows[0] ? present(rows[0], locale) : null;
  }
  async function writeComplete(
    sql: Sql, orgId: string, input: CreateServiceInput, published: boolean, reviewerId: string | null, id?: string,
  ): Promise<string | null> {
    const params = [orgId, input.externalId ?? null, input.categoryId, input.nameEn.trim(), input.nameEs.trim(),
      input.descriptionEn?.trim() ?? '', input.descriptionEs?.trim() ?? '', input.eligibilityNoteEn?.trim() ?? '',
      input.eligibilityNoteEs?.trim() ?? '', input.phone?.trim() ?? '', input.sourceUpdatedAt,
      published ? 'published' : 'draft', reviewerId];
    const rows = id
      ? await sql.query<{ id: string }>(`update services set external_id=$2, category_id=$3, name_en=$4, name_es=$5,
          description_en=$6, description_es=$7, eligibility_note_en=$8, eligibility_note_es=$9, phone=$10,
          source_updated_at=$11, publication_state=$12, reviewed_by=$13,
          reviewed_at=case when $12='published' then statement_timestamp() else null end
          where org_id=$1 and id=$14 returning id`, [...params, id])
      : await sql.query<{ id: string }>(`insert into services (org_id, external_id, category_id, name_en, name_es,
          description_en, description_es, eligibility_note_en, eligibility_note_es, phone, source_updated_at,
          publication_state, reviewed_by, reviewed_at)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
            case when $12='published' then statement_timestamp() else null end) returning id`, params);
    const writtenId = rows[0]?.id;
    if (!writtenId) return null;
    await replaceLanguages(sql, orgId, writtenId, input.languages ?? []);
    await replaceAccessibility(sql, orgId, writtenId, input.accessibility ?? []);
    return writtenId;
  }
  async function patch(sql: Sql, orgId: string, actorId: string, id: string, input: PatchServiceInput, locale: ServiceLocale) {
    const rows = await sql.query<ServiceRow>(`select ${projection} from services s
      where s.org_id=$1 and s.id=$2 for update of s`, [orgId, id]);
    const before = rows[0];
    if (!before) return null;
    const changedFields: string[] = [];
    const compare = (provided: boolean, changed: boolean, field: string) => { if (provided && changed) changedFields.push(field); };
    compare(input.externalId !== undefined, input.externalId !== before.external_id, 'external_id');
    compare(input.categoryId !== undefined, input.categoryId !== before.category_id, 'category_id');
    compare(input.nameEn !== undefined, input.nameEn?.trim() !== before.name_en, 'name_en');
    compare(input.nameEs !== undefined, input.nameEs?.trim() !== before.name_es, 'name_es');
    compare(input.descriptionEn !== undefined, input.descriptionEn?.trim() !== before.description_en, 'description_en');
    compare(input.descriptionEs !== undefined, input.descriptionEs?.trim() !== before.description_es, 'description_es');
    compare(input.eligibilityNoteEn !== undefined, input.eligibilityNoteEn?.trim() !== before.eligibility_note_en, 'eligibility_note_en');
    compare(input.eligibilityNoteEs !== undefined, input.eligibilityNoteEs?.trim() !== before.eligibility_note_es, 'eligibility_note_es');
    compare(input.phone !== undefined, input.phone?.trim() !== before.phone, 'phone');
    compare(input.sourceUpdatedAt !== undefined,
      input.sourceUpdatedAt === undefined || new Date(input.sourceUpdatedAt).toISOString() !== new Date(before.source_updated_at).toISOString(),
      'source_updated_at');
    compare(input.languages !== undefined, !sameStrings(uniqueSorted(input.languages), uniqueSorted(before.languages)), 'languages');
    compare(input.accessibility !== undefined,
      !sameStrings(uniqueSorted(input.accessibility), uniqueSorted(before.accessibility)), 'accessibility');
    const didWrite = changedFields.length > 0 || before.publication_state === 'draft';
    if (!didWrite) return { service: present(before, locale), changedFields, didWrite };
    await sql.query(`update services set external_id=coalesce($3,external_id), category_id=coalesce($4::uuid,category_id),
      name_en=coalesce($5,name_en), name_es=coalesce($6,name_es), description_en=coalesce($7,description_en),
      description_es=coalesce($8,description_es), eligibility_note_en=coalesce($9,eligibility_note_en),
      eligibility_note_es=coalesce($10,eligibility_note_es), phone=coalesce($11,phone),
      source_updated_at=coalesce($12::timestamptz,source_updated_at), publication_state='published',
      reviewed_by=$13, reviewed_at=statement_timestamp() where org_id=$1 and id=$2`,
    [orgId, id, input.externalId ?? null, input.categoryId ?? null, input.nameEn?.trim() ?? null,
      input.nameEs?.trim() ?? null, input.descriptionEn?.trim() ?? null, input.descriptionEs?.trim() ?? null,
      input.eligibilityNoteEn?.trim() ?? null, input.eligibilityNoteEs?.trim() ?? null, input.phone?.trim() ?? null,
      input.sourceUpdatedAt ?? null, actorId]);
    if (input.languages !== undefined) await replaceLanguages(sql, orgId, id, input.languages);
    if (input.accessibility !== undefined) await replaceAccessibility(sql, orgId, id, input.accessibility);
    const approvalFields = before.publication_state === 'draft'
          ? ['publication_state', 'reviewed_by', 'reviewed_at'] : [];
    await auditUpdate(sql, orgId, actorId, id, [...changedFields, ...approvalFields],
      changedFields.length > 0 ? 'service updated and approved by staff' : 'imported service approved by staff');
    const service = await load(sql, orgId, id, locale, false);
    if (!service) throw new Error('Service patch read-back failed');
    return { service, changedFields, didWrite };
  }
  return {
    listCategories: (orgId: string) => withOrg(orgId, sql => sql.query<ServiceCategory>(
      'select id, label_en, label_es from service_categories where org_id = $1 order by label_en, id', [orgId])),
    /** Public read: CSV drafts are invisible until a staff PATCH approves them. */
    get: (orgId: string, id: string, locale: ServiceLocale) => withOrg(orgId, sql => load(sql, orgId, id, locale, true)),
    /** A direct staff POST is reviewed by that actor and published immediately. */
    create: (orgId: string, actorId: string, input: CreateServiceInput, locale: ServiceLocale) => withOrg(orgId, async sql => {
      const id = await writeComplete(sql, orgId, input, true, actorId);
      if (!id) return null;
      await auditUpdate(sql, orgId, actorId, id, createFields, 'service created and published by staff');
      return load(sql, orgId, id, locale, false);
    }),
    /** A staff PATCH is also the explicit approval operation for an imported draft. */
    update: (orgId: string, actorId: string, id: string, input: PatchServiceInput, locale: ServiceLocale) =>
      withOrg(orgId, sql => patch(sql, orgId, actorId, id, input, locale)),
    search: (orgId: string, search: ServiceSearch) => withOrg(orgId, async sql => {
      const requestedLimit = search.limit ?? 20;
      if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) {
        throw new ServiceValidationError('limit must be an integer from 1 through 100');
      }
      if (search.cursor !== undefined && !/^\d+$/u.test(search.cursor)) {
        throw new ServiceValidationError('cursor must be a non-negative integer');
      }
      const offset = Number(search.cursor ?? 0);
      if (!Number.isSafeInteger(offset) || offset > maxSearchOffset) {
        throw new ServiceValidationError(`cursor must not exceed ${maxSearchOffset}`);
      }
      const query = search.query?.trim() ?? '';
      const locale = search.locale;
      const rows = await sql.query<ServiceRow & { rank: number }>(`select ${projection},
          case when $2 = '' then 0 else ts_rank_cd(case when $3 = 'es' then s.search_es else s.search_en end,
            websearch_to_tsquery(case when $3 = 'es' then 'spanish'::regconfig else 'english'::regconfig end, $2), 32) end as rank
        from services s where s.org_id = $1 and s.publication_state = 'published'
          and ($2 = '' or (case when $3 = 'es' then s.search_es else s.search_en end) @@
            websearch_to_tsquery(case when $3 = 'es' then 'spanish'::regconfig else 'english'::regconfig end, $2))
          and ($4::text is null or s.category_id::text = $4::text)
          and ($5::text is null or exists (select 1 from service_languages sl where sl.org_id=$1 and sl.service_id=s.id and sl.language_code=$5::text))
          and ($6::text is null or exists (select 1 from service_accessibility sa where sa.org_id=$1 and sa.service_id=s.id and sa.accessibility_code=$6::text))
        order by rank desc, case when $3='es' then s.name_es else s.name_en end asc, s.id asc offset $7 limit $8`,
      [orgId, query, locale, search.categoryId ?? null, search.language ?? null, search.accessibility ?? null,
        offset, requestedLimit + 1]);
      return { items: rows.slice(0, requestedLimit).map(row => present(row, locale)),
        nextCursor: rows.length > requestedLimit ? String(offset + requestedLimit) : null };
    }),
    /** Complete CSV rows are written as drafts; a later staff PATCH is the only publication transition. */
    importRows: (orgId: string, actorId: string, rows: readonly { row: number; input: CreateServiceInput }[], rejectedRows = 0) =>
      withOrg(orgId, async sql => {
        const imported: { row: number; id: string; outcome: 'created' | 'updated' }[] = [];
        const rejected: { row: number; reason: string }[] = [];
        const importRows = await sql.query<{ id: string }>(
          'insert into service_imports (org_id, actor_id, status, accepted_rows, rejected_rows) values ($1,$2,$3,$4,$5) returning id',
          [orgId, actorId, 'committed', rows.length, rejectedRows]);
        const importId = importRows[0]?.id;
        if (!importId) throw new Error('Service import write failed');
        for (const item of rows) {
          const categories = await sql.query<{ exists: boolean }>(
            'select exists(select 1 from service_categories where org_id=$1 and id=$2) as exists', [orgId, item.input.categoryId]);
          if (categories[0]?.exists !== true) {
            rejected.push({ row: item.row, reason: 'category_id does not identify a category in this organisation' });
            continue;
          }
          const existing = await sql.query<ServiceRow>(`select ${projection} from services s
            where s.org_id=$1 and s.external_id=$2 limit 1 for update of s`, [orgId, item.input.externalId ?? null]);
          const before = existing[0];
          const id = await writeComplete(sql, orgId, item.input, false, null, before?.id);
          if (!id) throw new Error(`Service import row ${item.row} write failed`);
          const outcome = existing.length > 0 ? 'updated' as const : 'created' as const;
          const auditFields = before ? completeChanges(before, item.input) : [...createFields];
          if (before && before.publication_state !== 'draft') auditFields.push('publication_state');
          if (before?.reviewed_by !== null && before?.reviewed_by !== undefined) auditFields.push('reviewed_by');
          if (before?.reviewed_at !== null && before?.reviewed_at !== undefined) auditFields.push('reviewed_at');
          await auditUpdate(sql, orgId, actorId, id, auditFields, `CSV import ${outcome} as draft`);
          imported.push({ row: item.row, id, outcome });
        }
        if (rejected.length > 0) await sql.query(
          'update service_imports set accepted_rows=$3, rejected_rows=$4 where org_id=$1 and id=$2',
          [orgId, importId, imported.length, rejectedRows + rejected.length]);
        return { importId, imported, rejected };
      }),
  };
}
export type ServicesRepository = ReturnType<typeof createServicesRepository>;
