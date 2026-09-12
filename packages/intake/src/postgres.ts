import { randomUUID } from 'node:crypto';
import type { IntakeKind, IntakeRepository, IntakeState, IntakeSubmission, IntakeTransaction, NarrativeCipher,
  PartnerCategory } from './types.ts';

interface IntakeRow extends Record<string, unknown> {
  id: string; org_id: string; resident_id: string; kind: IntakeKind; answers_ciphertext: string; answers_iv: string; answers_tag: string;
  locale: 'en' | 'es'; disclaimer_acknowledged: boolean; state: IntakeState; category_id: string | null;
  category_slug: string | null; label_en: string | null; label_es: string | null; created_at: string | Date; updated_at: string | Date;
}

const projection = `i.id,i.org_id,i.resident_id,i.kind,encode(i.answers_ciphertext,'base64') as answers_ciphertext,
  encode(i.answers_iv,'base64') as answers_iv,encode(i.answers_tag,'base64') as answers_tag,i.locale,i.disclaimer_acknowledged,i.state,
  c.id as category_id,c.slug as category_slug,c.label_en,c.label_es,i.created_at,i.updated_at`;

const encryptionContext = (orgId: string, residentId: string, id: string, kind: IntakeKind) => `${orgId}:${residentId}:${id}:${kind}`;

function hydrate(row: IntakeRow, cipher: NarrativeCipher): IntakeSubmission {
  const routedCategory: PartnerCategory | null = row.category_id && row.category_slug && row.label_en && row.label_es
    ? { id: row.category_id, slug: row.category_slug, labelEn: row.label_en, labelEs: row.label_es } : null;
  return { id: row.id, orgId: row.org_id, residentId: row.resident_id, kind: row.kind,
    answers: cipher.decrypt({ ciphertext: row.answers_ciphertext, iv: row.answers_iv, tag: row.answers_tag },
      encryptionContext(row.org_id, row.resident_id, row.id, row.kind)),
    locale: row.locale, disclaimerAcknowledged: row.disclaimer_acknowledged,
    intent: row.state === 'draft' ? 'save_draft' : 'submit', state: row.state, routedCategory,
    createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() };
}

export function createPostgresIntakeRepository(transaction: IntakeTransaction, cipherSource: () => NarrativeCipher): IntakeRepository {
  async function load(sql: Parameters<Parameters<IntakeTransaction>[1]>[0], orgId: string, residentId: string, id: string) {
    const rows = await sql.query<IntakeRow>(`select ${projection} from intake_submissions i left join service_categories c
      on c.org_id=i.org_id and c.id=i.routed_category_id where i.org_id=$1 and i.resident_id=$2 and i.id=$3 limit 1`,
    [orgId, residentId, id]);
    return rows[0] ? hydrate(rows[0], cipherSource()) : null;
  }

  return {
    save: (orgId, residentId, kind, input, route, key, hash, at, id) => transaction(orgId, async sql => {
      const scope = id ?? kind;
      await sql.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`${orgId}:${residentId}:${scope}:${key}`]);
      const replays = await sql.query<{ request_hash: string; submission_id: string }>(`select request_hash,submission_id
        from intake_mutations where org_id=$1 and resident_id=$2 and mutation_scope=$3 and idempotency_key=$4 limit 1`,
      [orgId, residentId, scope, key]);
      const replay = replays[0];
      if (replay) {
        if (replay.request_hash !== hash) throw Object.assign(new Error('Idempotency conflict'), { status: 409 });
        const submission = await load(sql, orgId, residentId, replay.submission_id);
        if (!submission) throw new Error('Intake replay target is unavailable');
        return { submission, created: false };
      }

      let submissionId = id;
      if (id) {
        const existing = await sql.query<{ kind: IntakeKind; state: IntakeState }>(`select kind,state from intake_submissions
          where org_id=$1 and resident_id=$2 and id=$3 for update`, [orgId, residentId, id]);
        if (!existing[0] || existing[0].kind !== kind || existing[0].state !== 'draft') return null;
        const encrypted = cipherSource().encrypt(input.answers, encryptionContext(orgId, residentId, id, kind));
        await sql.query(`update intake_submissions set answers_ciphertext=decode($4,'base64'),answers_iv=decode($5,'base64'),
          answers_tag=decode($6,'base64'),locale=$7,disclaimer_acknowledged=$8,updated_at=$9::timestamptz
          where org_id=$1 and resident_id=$2 and id=$3`,
        [orgId, residentId, id, encrypted.ciphertext, encrypted.iv, encrypted.tag, input.locale, input.disclaimerAcknowledged, at]);
      } else {
        submissionId = randomUUID();
        const encrypted = cipherSource().encrypt(input.answers, encryptionContext(orgId, residentId, submissionId, kind));
        const inserted = await sql.query<{ id: string }>(`insert into intake_submissions
          (id,org_id,resident_id,kind,answers_ciphertext,answers_iv,answers_tag,locale,disclaimer_acknowledged,state,created_at,updated_at)
          values ($1,$2,$3,$4,decode($5,'base64'),decode($6,'base64'),decode($7,'base64'),$8,$9,'draft',$10::timestamptz,$10::timestamptz)
          returning id`,
        [submissionId, orgId, residentId, kind, encrypted.ciphertext, encrypted.iv, encrypted.tag, input.locale,
          input.disclaimerAcknowledged, at]);
        submissionId = inserted[0]?.id;
        if (!submissionId) throw new Error('Intake insert did not return an id');
      }

      if (route) {
        const categories = await sql.query<{ id: string }>(`select id from service_categories
          where org_id=$1 and slug=$2 limit 1 for share`, [orgId, route.slug]);
        const categoryId = categories[0]?.id;
        if (!categoryId) throw Object.assign(new Error('Partner category is unavailable'), { status: 422 });
        await sql.query(`update intake_submissions set state='routed',routed_category_id=$4,route_reason_code=$5,
          updated_at=$6::timestamptz where org_id=$1 and resident_id=$2 and id=$3 and state='draft'`,
        [orgId, residentId, submissionId!, categoryId, route.reasonCode, at]);
      }
      const auditFields = route
        ? "ARRAY['answers','disclaimer_acknowledged','locale','route_reason_code','routed_category_id','state']::text[]"
        : "ARRAY['answers','disclaimer_acknowledged','locale','state']::text[]";
      await sql.query(`insert into audit_events (actor,on_behalf_of,action,target,org_id,outcome,reason,fields)
        values ($1,null,$2,$3,$4,'allowed',$5,${auditFields})`,
      [`user:${residentId}`, route ? 'intake.routed' : 'intake.saved', `intake_submission:${submissionId!}`, orgId,
        route?.reasonCode ?? (id ? 'draft_replaced' : 'draft_created')]);
      await sql.query(`insert into intake_mutations
        (org_id,resident_id,submission_id,mutation_scope,idempotency_key,request_hash)
        values ($1,$2,$3,$4,$5,$6)`, [orgId, residentId, submissionId!, scope, key, hash]);
      const submission = await load(sql, orgId, residentId, submissionId!);
      if (!submission) throw new Error('Intake write read-back failed');
      return { submission, created: id === undefined };
    }),
    get: (orgId, residentId, id) => transaction(orgId, sql => load(sql, orgId, residentId, id)),
  };
}
