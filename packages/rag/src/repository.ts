import type {
  PreparedService, RagOrgTransaction, RagRepository, RagSql, RagTrustedStorage, ReindexContextResolver, RetrievalHit,
} from './types.ts';
import { safeScore } from './validation.ts';

interface ServiceSourceRow {
  id: string;
  content: string;
  content_version: string;
  content_fingerprint: string;
  idempotency_key: string | null;
}

const sourceProjection = `s.id,
  concat_ws(E'\\n', s.name_en, s.description_en, s.eligibility_note_en,
    s.name_es, s.description_es, s.eligibility_note_es,
    coalesce((select string_agg(sl.language_code, ',' order by sl.language_code)
      from service_languages sl where sl.org_id=s.org_id and sl.service_id=s.id), ''),
    coalesce((select string_agg(sa.accessibility_code, ',' order by sa.accessibility_code)
      from service_accessibility sa where sa.org_id=s.org_id and sa.service_id=s.id), '')) as content,
  to_char(s.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as content_version,
  md5(concat_ws(E'\\x1f', s.name_en, s.description_en, s.eligibility_note_en,
    s.name_es, s.description_es, s.eligibility_note_es, s.category_id::text, s.phone,
    coalesce((select string_agg(sl.language_code, ',' order by sl.language_code)
      from service_languages sl where sl.org_id=s.org_id and sl.service_id=s.id), ''),
    coalesce((select string_agg(sa.accessibility_code, ',' order by sa.accessibility_code)
      from service_accessibility sa where sa.org_id=s.org_id and sa.service_id=s.id), ''))) as content_fingerprint`;

function vectorLiteral(vector: readonly number[]): string { return `[${vector.join(',')}]`; }

export function createReindexContextResolver(storage: RagTrustedStorage): ReindexContextResolver {
  return {
    async resolveService(serviceId) {
      const rows = await storage.query<{ org_id: string; reviewed_by: string }>(`select org_id, reviewed_by
        from services where id=$1 and publication_state='published' and reviewed_by is not null limit 1`, [serviceId]);
      const row = rows[0];
      return row ? { orgId: row.org_id, gatewayUserId: row.reviewed_by } : null;
    },
  };
}

export function createRagRepository(withOrg: RagOrgTransaction): RagRepository {
  async function source(sql: RagSql, orgId: string, serviceId: string,
    lock: boolean): Promise<ServiceSourceRow | null> {
    const rows = await sql.query<ServiceSourceRow>(`select ${sourceProjection}, e.idempotency_key
      from services s left join service_embeddings e on e.org_id=s.org_id and e.service_id=s.id
      where s.org_id=$1 and s.id=$2 and s.publication_state='published' ${lock ? 'for update of s' : ''}`,
    [orgId, serviceId]);
    return rows[0] ?? null;
  }

  return {
    prepare: (orgId, serviceId, idempotencyKey) => withOrg(orgId, async sql => {
      const row = await source(sql, orgId, serviceId, false);
      if (!row) return null;
      const prepared: PreparedService = {
        serviceId: row.id, content: row.content, contentVersion: row.content_version,
        contentFingerprint: row.content_fingerprint, alreadyProcessed: row.idempotency_key === idempotencyKey,
      };
      return prepared;
    }),
    replace: input => withOrg(input.orgId, async sql => {
      const current = await source(sql, input.orgId, input.serviceId, true);
      if (!current) return 'missing';
      if (current.idempotency_key === input.idempotencyKey) return 'duplicate';
      if (current.content_version !== input.contentVersion || current.content_fingerprint !== input.contentFingerprint) return 'stale';
      await sql.query(`insert into service_embeddings
          (org_id, service_id, content_version, content_fingerprint, embedding, dimensions, embedding_model,
            idempotency_key, reindex_actor, embedded_at)
        values ($1,$2,$3,$4,$5::vector,$6,$7,$8,'system:rag-reindex',statement_timestamp())
        on conflict (org_id, service_id) do update set content_version=excluded.content_version,
          content_fingerprint=excluded.content_fingerprint, embedding=excluded.embedding, dimensions=excluded.dimensions,
          embedding_model=excluded.embedding_model, idempotency_key=excluded.idempotency_key,
          reindex_actor=excluded.reindex_actor, embedded_at=excluded.embedded_at`,
      [input.orgId, input.serviceId, input.contentVersion, input.contentFingerprint, vectorLiteral(input.embedding),
        input.dimensions, input.model, input.idempotencyKey]);
      return 'indexed';
    }),
    hybrid: (orgId, query, locale, embedding, dimensions, limit) => withOrg(orgId, async sql => {
      const rows = await sql.query<{ service_id: string; score: number | string }>(`with
        published_services as materialized (
          select s.*, case when $3='es' then s.search_es else s.search_en end as search_vector
          from services s where s.org_id=$1 and s.publication_state='published'
        ),
        fts as (
          select id, row_number() over (order by ts_rank_cd(search_vector,
            websearch_to_tsquery(case when $3='es' then 'spanish'::regconfig else 'english'::regconfig end, $2), 32) desc, id) as rank
          from published_services where search_vector @@
            websearch_to_tsquery(case when $3='es' then 'spanish'::regconfig else 'english'::regconfig end, $2)
          limit $4
        ), current_vectors as materialized (
          select s.id, e.embedding from published_services s
          join service_embeddings e on e.org_id=s.org_id and e.service_id=s.id
          where e.dimensions=$5
            and e.content_version=to_char(s.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
            and e.content_fingerprint=md5(concat_ws(E'\\x1f', s.name_en, s.description_en, s.eligibility_note_en,
              s.name_es, s.description_es, s.eligibility_note_es, s.category_id::text, s.phone,
              coalesce((select string_agg(sl.language_code, ',' order by sl.language_code)
                from service_languages sl where sl.org_id=s.org_id and sl.service_id=s.id), ''),
              coalesce((select string_agg(sa.accessibility_code, ',' order by sa.accessibility_code)
                from service_accessibility sa where sa.org_id=s.org_id and sa.service_id=s.id), '')))
        ), semantic as (
          select id, row_number() over (order by embedding <=> $6::vector, id) as rank
          from current_vectors order by embedding <=> $6::vector, id limit $4
        )
        select coalesce(fts.id, semantic.id) as service_id,
          (coalesce(1.0/(60+fts.rank),0)+coalesce(1.0/(60+semantic.rank),0))/0.03278688524590164 as score
        from fts full join semantic on semantic.id=fts.id
        order by score desc, service_id limit $4`,
      [orgId, query, locale, limit, dimensions, vectorLiteral(embedding)]);
      return rows.map(row => ({ service_id: row.service_id, score: safeScore(Number(row.score)) })) satisfies RetrievalHit[];
    }),
  };
}
