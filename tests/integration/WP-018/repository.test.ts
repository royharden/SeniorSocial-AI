import { describe, expect, it } from 'vitest';
import { createIntakeNarrativeCipher, createPostgresIntakeRepository, type IntakeSql } from '../../../packages/intake/src/index';

describe('WP-018 PostgreSQL repository composition', () => {
  it('routes and records idempotency within one tenant transaction, then replays without a second write', async () => {
    let transactionCount = 0; let state: 'draft' | 'routed' = 'draft'; let receipt: { hash: string; id: string } | null = null;
    let encrypted = { ciphertext: '', iv: '', tag: '' };
    let storedId = '';
    const writes: string[] = [];
    const sql: IntakeSql = { query: <Row extends Record<string, unknown>>(text: string, values: readonly (string | boolean | null)[]) => {
      const normalized = text.replace(/\s+/gu, ' ').trim(); let rows: Record<string, unknown>[] = [];
      if (normalized.includes('from intake_mutations')) rows = receipt ? [{ request_hash: receipt.hash, submission_id: receipt.id }] : [];
      else if (normalized.startsWith('insert into intake_submissions')) {
        writes.push('insert'); storedId = String(values[0]);
        encrypted = { ciphertext: String(values[4]), iv: String(values[5]), tag: String(values[6]) };
        expect(values.join('|')).not.toContain('private'); rows = [{ id: String(values[0]) }];
      }
      else if (normalized.startsWith('select id from service_categories')) rows = [{ id: '50000000-0000-4000-8000-000000000001' }];
      else if (normalized.startsWith("update intake_submissions set state='routed'")) { writes.push('route'); state = 'routed'; }
      else if (normalized.startsWith('insert into audit_events')) {
        writes.push(`audit:${String(values[1])}`);
        expect(values.join('|')).not.toContain('private');
      }
      else if (normalized.startsWith('insert into intake_mutations')) {
        writes.push('receipt'); receipt = { hash: String(values[5]), id: String(values[2]) };
      } else if (normalized.startsWith('select i.id')) rows = [{
        id: storedId, org_id: values[0], resident_id: values[1], kind: 'legal',
        answers_ciphertext: encrypted.ciphertext, answers_iv: encrypted.iv, answers_tag: encrypted.tag,
        locale: 'en', disclaimer_acknowledged: true, state,
        category_id: state === 'routed' ? '50000000-0000-4000-8000-000000000001' : null,
        category_slug: state === 'routed' ? 'housing' : null, label_en: state === 'routed' ? 'Housing' : null,
        label_es: state === 'routed' ? 'Vivienda' : null, created_at: '2026-09-11T02:00:00Z', updated_at: '2026-09-11T02:00:00Z',
      }];
      return Promise.resolve(rows as Row[]);
    } };
    const cipher = createIntakeNarrativeCipher(Buffer.alloc(32, 7).toString('base64'));
    const repository = createPostgresIntakeRepository(async (_orgId, work) => { transactionCount += 1; return work(sql); }, () => cipher);
    const args = ['30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'legal',
      { answers: { topic: 'housing', summary: 'private' }, locale: 'en', disclaimerAcknowledged: true, intent: 'submit' },
      { slug: 'housing', reasonCode: 'legal_housing' }, 'postgres-key-001', 'a'.repeat(64), '2026-09-11T02:00:00Z'] as const;
    const first = await repository.save(...args); const replay = await repository.save(...args);
    expect(first?.submission).toMatchObject({ state: 'routed', routedCategory: { slug: 'housing', labelEn: 'Housing' } });
    expect(replay?.submission.id).toBe(first?.submission.id);
    expect(writes).toEqual(['insert', 'route', 'audit:intake.routed', 'receipt']); expect(transactionCount).toBe(2);
  });
});
